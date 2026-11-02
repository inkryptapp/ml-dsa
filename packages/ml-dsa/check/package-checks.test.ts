import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite-plus/pack";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { manifestHashes } from "../../../scripts/vector-manifest.ts";
import { toolTimeout } from "../test/dev-tools.ts";
import { packConfigs } from "../vite.config.ts";
import { scanPatterns } from "./host-paths.ts";
import {
	attwFailures,
	copiedFiles,
	embeddedModule,
	expectedExports,
	importFailures,
	manifestFailures,
	packageFailures,
	repositoryUrl,
	tarballFilesFile,
	tarballLimit,
	type PackageInputs,
} from "./package-checks.ts";

const packageRoot = join(root, "packages/ml-dsa");

/**
 * Builds both pack configs in memory, as `vp pack` builds them, and adds the
 * files that the pack copies from the repo. The license copy is left out, so
 * the build writes nothing.
 */
async function packedFiles(): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	for (const config of packConfigs) {
		const handle = await build({
			...config,
			hooks: {},
			write: false,
			clean: false,
			config: false,
			cwd: packageRoot,
			logLevel: "silent",
		});
		for (const chunk of handle.bundles.flatMap((bundle) => bundle.chunks)) {
			const bytes = chunk.type === "chunk" ? chunk.code : chunk.source;
			files.set(`dist/${chunk.fileName}`, Buffer.from(bytes));
		}
	}
	for (const [path, repoPath] of copiedFiles) {
		if (!files.has(path)) {
			files.set(path, readFileSync(join(root, repoPath)));
		}
	}
	return files;
}

function text(files: ReadonlyMap<string, Uint8Array>, path: string): string {
	return Buffer.from(files.get(path) ?? []).toString("utf8");
}

const repoManifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

/** The repo's package.json with `change` applied to a copy. */
function manifestWith(change: (manifest: Record<string, unknown>) => void): unknown {
	const manifest: Record<string, unknown> = structuredClone(
		Object.fromEntries(Object.entries(repoManifest ?? {})),
	);
	change(manifest);
	return manifest;
}

describe("the package.json rules", () => {
	test("pass the repo's package.json", () => {
		expect(manifestFailures(repoManifest)).toStrictEqual([]);
	});

	test.each([
		[
			"CommonJS",
			(manifest: Record<string, unknown>) => {
				manifest["type"] = "commonjs";
			},
			'package.json must set "type": "module".',
		],
		[
			"another engines range",
			(manifest: Record<string, unknown>) => {
				manifest["engines"] = { node: ">=20" };
			},
			'package.json must set "engines" to exactly { "node": ">=22" }.',
		],
		[
			"the workerd condition after import",
			(manifest: Record<string, unknown>) => {
				const { workerd, import: esm } = expectedExports["."];
				manifest["exports"] = { ".": { import: esm, workerd }, "./package.json": "./package.json" };
			},
			`package.json must set "exports" to exactly ${JSON.stringify(expectedExports)}, in that key order.`,
		],
		[
			"a require condition",
			(manifest: Record<string, unknown>) => {
				manifest["exports"] = {
					...expectedExports,
					".": { ...expectedExports["."], require: "./dist/index.cjs" },
				};
			},
			`package.json must set "exports" to exactly ${JSON.stringify(expectedExports)}, in that key order.`,
		],
		[
			"no mldsaNative field",
			(manifest: Record<string, unknown>) => {
				delete manifest["mldsaNative"];
			},
			'package.json must set "mldsaNative" to an object of exactly a "tag" and a "commit" string.',
		],
		[
			"another form of the repository URL",
			(manifest: Record<string, unknown>) => {
				manifest["repository"] = { type: "git", url: "https://github.com/inkryptapp/ml-dsa" };
			},
			`package.json gives "https://github.com/inkryptapp/ml-dsa" as "repository.url" instead of ${JSON.stringify(repositoryUrl)}.`,
		],
		[
			"a main field",
			(manifest: Record<string, unknown>) => {
				manifest["main"] = "./dist/index.js";
			},
			'package.json has a "main" field, which the package must not have.',
		],
		[
			"a top-level types field",
			(manifest: Record<string, unknown>) => {
				manifest["types"] = "./dist/index.d.ts";
			},
			'package.json has a "types" field, which the package must not have.',
		],
		[
			"a runtime dependency",
			(manifest: Record<string, unknown>) => {
				manifest["dependencies"] = { "@noble/post-quantum": "0.7.1" };
			},
			'package.json has a "dependencies" field, which the package must not have.',
		],
	])("fail %s", (_name, change, message) => {
		expect(manifestFailures(manifestWith(change))).toStrictEqual([message]);
	});
});

describe("the import rules of shipped files", () => {
	const files = new Set(["dist/index.js", "dist/workerd.js", "dist/mldsa.wasm"]);

	test("pass an import of another shipped file", () => {
		expect(
			importFailures("dist/workerd.js", 'import compiled from "./mldsa.wasm";', files),
		).toStrictEqual([]);
	});

	test.each([
		[
			"an import of noble",
			'import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";',
			'dist/index.js:1 imports "@noble/post-quantum/ml-dsa.js", a package or a built-in module. The package has zero runtime dependencies, so it may import only its own files.',
		],
		[
			"a built-in module",
			'import { readFileSync } from "node:fs";',
			'dist/index.js:1 imports "node:fs", a package or a built-in module. The package has zero runtime dependencies, so it may import only its own files.',
		],
		[
			"a JSON import",
			'export { default } from "../wasm/sizes.json";',
			'dist/index.js:1 imports the JSON file "../wasm/sizes.json". The pack build must inline it.',
		],
		[
			"an import with attributes",
			'import sizes from "./sizes" with { type: "json" };',
			'dist/index.js:1 imports "./sizes" with import attributes, as a JSON import has.',
		],
		[
			"a dynamic import of a computed name",
			"const name = './index.js';\nawait import(name);",
			"dist/index.js:2 imports a module whose name the file computes.",
		],
		[
			"a JSON import with a query",
			'import manifest from "../package.json?cache=1";',
			'dist/index.js:1 imports the JSON file "../package.json?cache=1". The pack build must inline it.',
		],
		[
			"an import that climbs out of the package folder",
			'import "../../dist/workerd.js";',
			'dist/index.js:1 imports "../../dist/workerd.js", which climbs out of the package folder.',
		],
		[
			"a shipped file that the tarball lacks",
			'import "./testing.js";',
			'dist/index.js:1 imports "./testing.js", which the tarball doesn\'t hold.',
		],
	])("fail %s", (_name, source, message) => {
		expect(importFailures("dist/index.js", source, files)).toStrictEqual([message]);
	});

	test("fail a require call", () => {
		expect(importFailures("dist/index.js", 'require("./index.cjs");', files)).toStrictEqual([
			'dist/index.js:1 imports "./index.cjs", which the tarball doesn\'t hold.',
		]);
	});

	test("fail a type import of a package in the declarations", () => {
		expect(
			importFailures(
				"dist/index.d.ts",
				'export declare const a: import("@noble/hashes").Hash;',
				new Set(["dist/index.d.ts"]),
			),
		).toStrictEqual([
			'dist/index.d.ts:1 imports "@noble/hashes", a package or a built-in module. The package has zero runtime dependencies, so it may import only its own files.',
		]);
	});
});

describe("the embedded module", () => {
	test("is the decoded text of a string literal", () => {
		expect(embeddedModule('atob("AGFzbQ==");')).toStrictEqual(Buffer.from("\0asm"));
	});

	test("is the decoded string that one declaration binds", () => {
		expect(embeddedModule('var text = "AGFzbQ==";\nconst bytes = atob(text);')).toStrictEqual(
			Buffer.from("\0asm"),
		);
	});

	test.each([
		["no atob call", "const a = 1;", "dist/index.js calls atob 0 times instead of once."],
		[
			"two atob calls",
			'atob("AA==");\natob("AA==");',
			"dist/index.js calls atob 2 times instead of once.",
		],
		[
			"a name that two declarations bind",
			'var a = "AA==";\nfunction f() { const a = "BB=="; }\natob(a);',
			"dist/index.js passes atob neither a string literal nor a name that one declaration binds to one.",
		],
		[
			"text that isn't base64",
			'atob("AGF*bQ==");',
			"dist/index.js passes atob text that isn't base64.",
		],
	])("can't be found in a file with %s", (_name, source, message) => {
		expect(embeddedModule(source)).toBe(message);
	});
});

describe("the package checks", { timeout: toolTimeout }, () => {
	let files = new Map<string, Uint8Array>();
	let inputs: PackageInputs | undefined = undefined;

	beforeAll(async () => {
		files = await packedFiles();
		inputs = {
			files,
			tarballBytes: 70_000,
			committedList: readFileSync(join(root, tarballFilesFile), "utf8"),
			repoFiles: new Map(
				[...copiedFiles.values()].map((file) => [file, readFileSync(join(root, file))]),
			),
			vectorHashes: manifestHashes(root),
			patterns: scanPatterns([{ name: "the repo", path: root }]),
		};
	});

	/** The failures for the packed files with `change` applied to a copy of them. */
	function failuresWith(
		change: (copy: Map<string, Uint8Array>) => void,
		overrides: Partial<PackageInputs> = {},
	): readonly string[] {
		if (inputs === undefined) {
			throw new Error("The packed files aren't built.");
		}
		const copy = new Map(files);
		change(copy);
		return packageFailures({ ...inputs, files: copy, ...overrides });
	}

	/** Replaces `before` with `after` once in the text of `path`. */
	function edit(copy: Map<string, Uint8Array>, path: string, before: string, after: string): void {
		const source = text(copy, path);
		expect(source).toContain(before);
		copy.set(path, Buffer.from(source.replace(before, after)));
	}

	test("pass the files that the pack configs build", () => {
		expect(failuresWith(() => {})).toStrictEqual([]);
	});

	test("fail a file that the committed list lacks", () => {
		expect(
			failuresWith((copy) => {
				copy.set("dist/extra.js", Buffer.from(""));
			}),
		).toStrictEqual([
			`${tarballFilesFile} lacks the line \`dist/extra.js\`, which the tarball gives.`,
			`If the change is intended, review it, then make ${tarballFilesFile} hold exactly the lines that the tarball gives.`,
		]);
	});

	test("fail a tarball over the size limit", () => {
		expect(failuresWith(() => {}, { tarballBytes: tarballLimit + 1 })).toStrictEqual([
			`The tarball is ${String(tarballLimit + 1)} bytes, over the limit of ${String(tarballLimit)}.`,
		]);
	});

	test("fail a package.json that isn't JSON", () => {
		const failures = failuresWith((copy) => {
			copy.set("package.json", Buffer.from("{"));
		});
		expect(failures).toContain("The tarball's package.json isn't valid JSON.");
	});

	test("fail a tarball without the workerd entry", () => {
		const failures = failuresWith((copy) => {
			copy.delete("dist/workerd.js");
		});
		expect(failures).toContain(
			"The tarball lacks dist/workerd.js, so the check can't compare the entries' modules.",
		);
	});

	test("fail a copied file that differs from its source", () => {
		expect(
			failuresWith((copy) => {
				copy.set("LICENSE", Buffer.from("MIT"));
			}),
		).toStrictEqual([
			"The tarball's LICENSE differs from LICENSE, which the pack copies unchanged.",
		]);
	});

	test("fail a vector file and the test-only entry point", () => {
		const vector = "acvp/ML-DSA-sigVer-FIPS204/expectedResults.json";
		const failures = failuresWith((copy) => {
			copy.set("dist/results.json", readFileSync(join(root, "vectors", vector)));
			copy.set("dist/testing.js", Buffer.from(""));
		});
		expect(failures).toContain(
			`The tarball holds dist/results.json, which is the vector file vectors/${vector}.`,
		);
		expect(failures).toContain(
			"The tarball holds dist/testing.js, which is the test-only entry point.",
		);
	});

	test("fail a default entry that embeds other bytes than the workerd entry imports", () => {
		const failures = failuresWith((copy) => {
			const wasm = Buffer.from(copy.get("dist/mldsa.wasm") ?? []);
			wasm[wasm.length - 1] = (wasm.at(-1) ?? 0) ^ 1;
			copy.set("dist/mldsa.wasm", wasm);
		});
		expect(failures).toContain(
			"The tarball's dist/mldsa.wasm differs from packages/ml-dsa/wasm/mldsa.wasm, which the pack copies unchanged.",
		);
		expect(
			failures.some((failure) =>
				failure.startsWith("The module that dist/index.js embeds, SHA-256 "),
			),
		).toBe(true);
	});

	test("fail a workerd entry that imports another file", () => {
		expect(
			failuresWith((copy) => {
				edit(copy, "dist/workerd.js", 'from "./mldsa.wasm"', 'from "./index.js"');
			}),
		).toStrictEqual(['dist/workerd.js imports ["./index.js"] instead of only "./mldsa.wasm".']);
	});

	test("apply the structural rules to each entry file", () => {
		for (const path of ["dist/index.js", "dist/workerd.js"]) {
			const failures = failuresWith((copy) => {
				edit(copy, path, "\t\t\t\tfailure = error;\n", "\t\t\t\tfailure = String(error);\n");
			});
			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatch(
				new RegExp(
					`^${path.replace(".", "\\.")}:\\d+: the core's catch block holds a call outside the four designated calls`,
				),
			);
		}
	});

	test("scan the shipped JavaScript for host paths", () => {
		const failures = failuresWith((copy) => {
			edit(copy, "dist/workerd.js", "//#region", "// /home/runner/x.ts\n//#region");
		});
		expect(failures).toStrictEqual([
			expect.stringMatching(
				/^dist\/workerd\.js holds "\/home", a generic host prefix, 1 time, first at byte \d+\.$/,
			),
		]);
	});

	test("scan the module that the default entry embeds for host paths", () => {
		const failures = failuresWith((copy) => {
			const index = text(copy, "dist/index.js");
			const [base64 = ""] = /"AGFzbQ[A-Za-z0-9+/=]*"/.exec(index) ?? [];
			const leaked = Buffer.concat([Buffer.from(base64.slice(1, -1), "base64"), Buffer.from(root)]);
			copy.set(
				"dist/index.js",
				Buffer.from(index.replace(base64, JSON.stringify(leaked.toString("base64")))),
			);
		});
		expect(failures).toContain(
			`The module that dist/index.js embeds holds "${root}", the repo, 1 time, first at byte ${String((files.get("dist/mldsa.wasm") ?? []).length)}.`,
		);
	});
});

describe("the attw check", { timeout: toolTimeout }, () => {
	const attw = join(root, "node_modules/.bin/attw");
	let folder = "";

	beforeAll(() => {
		folder = mkdtempSync(join(tmpdir(), "ml-dsa-attw-"));
	});

	afterAll(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	/** Packs an ES module package whose import condition gives `types` as its declarations. */
	function packWithTypes(name: string, types: string): string {
		const source = join(folder, name);
		mkdirSync(source);
		writeFileSync(
			join(source, "package.json"),
			JSON.stringify({
				name,
				version: "0.0.0",
				type: "module",
				exports: { ".": { import: { types, default: "./index.js" } } },
			}),
		);
		writeFileSync(join(source, "index.js"), "export const a = 1;\n");
		writeFileSync(join(source, types), "export declare const a: number;\n");
		const packed = spawnSync("npm", ["pack", "--silent", "--pack-destination", folder], {
			cwd: source,
			encoding: "utf8",
		});
		expect(packed.status).toBe(0);
		return join(folder, `${name}-0.0.0.tgz`);
	}

	test("passes a package whose import resolves to ES module declarations", () => {
		expect(attwFailures(attw, packWithTypes("esm-types", "./index.d.ts"))).toStrictEqual([]);
	});

	// The import condition resolves to CommonJS declarations for an ES module,
	// which attw reports as FalseCJS.
	test("fails a package whose types masquerade as CommonJS", () => {
		const tarball = packWithTypes("cjs-types", "./index.d.cts");
		const failures = attwFailures(attw, tarball);
		expect(failures).toHaveLength(1);
		const [failure = ""] = failures;
		expect(failure.startsWith(`\`attw ${tarball} --profile esm-only\` reports a problem:\n`)).toBe(
			true,
		);
		expect(failure).toContain("FalseCJS");
	});
});
