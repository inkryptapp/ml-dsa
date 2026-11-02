/**
 * The tarball tests. They pack the package, install the tarball into a
 * consumer folder with npm, and load it the ways a consumer does: in the
 * Node.js that runs the tests, through TypeScript, and through Vite. CI runs
 * this file on every maintained Node.js major in range.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import { root, toolTimeout } from "./dev-tools.js";

const packageRoot = join(root, "packages/ml-dsa");
const seed = new Uint8Array(32).fill(7);

function run(command: string, args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	return spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
}

/** Runs `command` and fails the test with its output unless it exits with status 0. */
function runOrFail(command: string, args: readonly string[], cwd: string): string {
	const result = run(command, args, cwd);
	if (result.status !== 0) {
		throw new Error(
			`\`${command} ${args.join(" ")}\` failed with status ${String(result.status)}:\n${result.stdout}${result.stderr}`,
		);
	}
	return result.stdout;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// The two keygen scripts print the SHA-256 of the public key that a fixed
// seed gives.
const keygenScript = `import { createHash } from "node:crypto";
import { mlDsa44 } from "ml-dsa";
const { publicKey } = mlDsa44.keygen(new Uint8Array(32).fill(7));
console.log(createHash("sha256").update(publicKey).digest("hex"));
`;

const dynamicImportScript = `const { createHash } = require("node:crypto");
(async () => {
	const { mlDsa44 } = await import("ml-dsa");
	const { publicKey } = mlDsa44.keygen(new Uint8Array(32).fill(7));
	console.log(createHash("sha256").update(publicKey).digest("hex"));
})();
`;

const requireScript = `try {
	require("ml-dsa");
	console.log("loaded");
} catch (error) {
	console.log(error.code);
}
`;

const manifestScript = `import manifest from "ml-dsa/package.json" with { type: "json" };
console.log(JSON.stringify(manifest.mldsaNative));
`;

const resolveScript = `console.log(import.meta.resolve("ml-dsa"));
`;

// Node gives a `.wasm` import no `WebAssembly.Module` as its default export.
// These hooks give one, as the Cloudflare Workers toolchain does, so the
// workerd entry runs in Node.
const workerdHooks = `import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
	load(url, context, nextLoad) {
		if (!url.endsWith(".wasm")) {
			return nextLoad(url, context);
		}
		const base64 = readFileSync(new URL(url)).toString("base64");
		const source = \`export default new WebAssembly.Module(Uint8Array.from(atob(\${JSON.stringify(base64)}), (c) => c.charCodeAt(0)));\`;
		return { format: "module", shortCircuit: true, source };
	},
});
`;

// The consumer calls the API with its declared types, so a broken
// declaration fails the compile.
const typedConsumer = `import { mlDsa44 } from "ml-dsa";
const seed: Uint8Array<ArrayBuffer> = new Uint8Array(mlDsa44.lengths.seed);
const { publicKey }: { readonly publicKey: Uint8Array<ArrayBuffer> } = mlDsa44.keygen(seed);
const valid: boolean = mlDsa44.verify({ publicKey, message: seed, signature: publicKey });
export { valid };
`;

describe("the packed tarball", { timeout: toolTimeout }, () => {
	let folder = "";
	let consumer = "";
	const expectedHash = sha256(mlDsa44.keygen(seed).publicKey);

	beforeAll(() => {
		folder = mkdtempSync(join(tmpdir(), "ml-dsa-tarball-"));
		runOrFail(process.execPath, [join(root, "node_modules/vite-plus/bin/vp"), "pack"], packageRoot);
		runOrFail(
			"npm",
			["pack", "--ignore-scripts", "--silent", "--pack-destination", folder],
			packageRoot,
		);
		const [tarball] = readdirSync(folder).filter((file) => file.endsWith(".tgz"));
		consumer = realpathSync(mkdtempSync(join(folder, "consumer-")));
		writeFileSync(
			join(consumer, "package.json"),
			JSON.stringify({ name: "consumer", private: true }),
		);
		runOrFail(
			"npm",
			[
				"install",
				"--offline",
				"--no-audit",
				"--no-fund",
				"--ignore-scripts",
				join(folder, tarball ?? ""),
			],
			consumer,
		);
		const scripts = {
			"keygen.mjs": keygenScript,
			"dynamic-import.cjs": dynamicImportScript,
			"require.cjs": requireScript,
			"manifest.mjs": manifestScript,
			"resolve.mjs": resolveScript,
			"workerd-hooks.mjs": workerdHooks,
			"consumer.cts": typedConsumer,
			"consumer.mts": typedConsumer,
			"consumer.ts": typedConsumer,
		};
		for (const [name, source] of Object.entries(scripts)) {
			writeFileSync(join(consumer, name), source);
		}
	});

	afterAll(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	function node(args: readonly string[]): SpawnSyncReturns<string> {
		return run(process.execPath, args, consumer);
	}

	describe(`in Node.js ${process.version}`, () => {
		test("loads through import and gives the source's public key", () => {
			const result = node(["keygen.mjs"]);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(`${expectedHash}\n`);
		});

		test("loads through import() from CommonJS", () => {
			const result = node(["dynamic-import.cjs"]);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(`${expectedHash}\n`);
		});

		test.each([[[]], [["--conditions=workerd"]]])(
			"rejects require() with ERR_PACKAGE_PATH_NOT_EXPORTED, with the flags %j",
			(flags) => {
				expect(node([...flags, "require.cjs"]).stdout).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED\n");
			},
		);

		test("imports ml-dsa/package.json", () => {
			const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
			const pin: unknown = Reflect.get(manifest ?? {}, "mldsaNative");
			expect(node(["manifest.mjs"]).stdout).toBe(`${JSON.stringify(pin)}\n`);
		});

		test.each([
			[[], "index.js"],
			[["--conditions=workerd"], "workerd.js"],
		])("with the flags %j, resolves the package to dist/%s", (flags, file) => {
			expect(node([...flags, "resolve.mjs"]).stdout).toBe(
				`file://${consumer}/node_modules/ml-dsa/dist/${file}\n`,
			);
		});

		test("runs the workerd entry when its .wasm import gives a WebAssembly.Module", () => {
			const result = node([
				"--conditions=workerd",
				"--import",
				"./workerd-hooks.mjs",
				"keygen.mjs",
			]);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe(`${expectedHash}\n`);
		});
	});

	describe("through TypeScript", () => {
		/** Compiles `file` in the consumer folder with `options`, and returns the result. */
		function compile(
			tsc: readonly string[],
			file: string,
			options: Record<string, unknown>,
		): SpawnSyncReturns<string> {
			const config = join(consumer, `tsconfig.${file}.json`);
			writeFileSync(
				config,
				JSON.stringify({
					compilerOptions: {
						strict: true,
						noEmit: true,
						lib: ["es2024"],
						types: [],
						skipLibCheck: false,
						...options,
					},
					files: [file],
				}),
			);
			const [command = "", ...args] = tsc;
			return run(command, [...args, "-p", config], consumer);
		}

		const tsc = [join(root, "node_modules/.bin/tsc")];
		const nodenext = { module: "nodenext", moduleResolution: "nodenext" };

		test("rejects a CommonJS consumer with TS2307", () => {
			const result = compile(tsc, "consumer.cts", nodenext);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe(
				"consumer.cts(1,25): error TS2307: Cannot find module 'ml-dsa' or its corresponding type declarations.\n",
			);
		});

		test("compiles an ES module consumer under nodenext", () => {
			const result = compile(tsc, "consumer.mts", nodenext);
			expect(result.stdout).toBe("");
			expect(result.status).toBe(0);
		});

		test('compiles a consumer under moduleResolution "bundler"', () => {
			const result = compile(tsc, "consumer.ts", { module: "esnext", moduleResolution: "bundler" });
			expect(result.stdout).toBe("");
			expect(result.status).toBe(0);
		});

		test("compiles a consumer with TypeScript 5.7 and skipLibCheck off", () => {
			const tsc57 = [process.execPath, join(root, "node_modules/typescript-5.7/bin/tsc")];
			expect(run(tsc57[0] ?? "", [tsc57[1] ?? "", "--version"], consumer).stdout).toBe(
				"Version 5.7.3\n",
			);
			const result = compile(tsc57, "consumer.mts", nodenext);
			expect(result.stdout).toBe("");
			expect(result.status).toBe(0);
		});
	});

	test("Vite resolves dist/index.js through the import condition", async () => {
		writeFileSync(
			join(consumer, "entry.js"),
			'import { mlDsa44 } from "ml-dsa";\nconsole.log(mlDsa44);\n',
		);
		const output = await build({
			root: consumer,
			configFile: false,
			logLevel: "silent",
			build: { write: false, rolldownOptions: { input: join(consumer, "entry.js") } },
		});
		const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) =>
			"output" in result ? result.output : [],
		);
		const moduleIds = chunks.flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []));
		const shipped = moduleIds.filter((id) => id.includes("/node_modules/ml-dsa/"));
		expect(shipped).toStrictEqual([`${consumer}/node_modules/ml-dsa/dist/index.js`]);
	});
});
