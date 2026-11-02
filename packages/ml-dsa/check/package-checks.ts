/**
 * The package checks, which read the files of the packed tarball. The pack
 * build bundles each entry into one file, so the checks parse the shipped
 * JavaScript to find what each file imports and the module bytes that the
 * default entry embeds.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { coreStructureFailures } from "./core-structure.ts";
import { child, children, field, isNode, nameOf, parseProgram, walk, type Node } from "./estree.ts";
import { hostPathFailures, type ScanPattern } from "./host-paths.ts";
import { snapshotFailures } from "./snapshot.ts";
import type { TarballFiles } from "./tarball.ts";

/**
 * The exports map that the package must ship. Neither `"."` nor its `workerd`
 * branch has a `require` or `default` condition, so `require()` fails with
 * the `workerd` condition too. Node and bundlers match conditions in key
 * order, so `workerd` comes first.
 */
export const expectedExports = {
	".": {
		workerd: { types: "./dist/index.d.ts", import: "./dist/workerd.js" },
		import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
	},
	"./package.json": "./package.json",
};

/** The default entry, which embeds the module as base64 text. */
export const defaultEntry = "dist/index.js";

/** The `workerd` entry, which imports the raw module. */
export const workerdEntry = "dist/workerd.js";

/** The entry files, which hold the core and its cleanup. */
export const entryFiles = [defaultEntry, workerdEntry] as const;

/** The raw module that the tarball ships, which the `workerd` entry imports. */
export const shippedModule = "dist/mldsa.wasm";

/** The committed list of the tarball's files, one path per line in sorted order. */
export const tarballFilesFile = "packages/ml-dsa/check/tarball-files.txt";

/**
 * The tarball's files that the pack copies unchanged from the repo, each
 * mapped to its path in the repo.
 */
export const copiedFiles: ReadonlyMap<string, string> = new Map([
	["package.json", "packages/ml-dsa/package.json"],
	["README.md", "packages/ml-dsa/README.md"],
	["LICENSE", "LICENSE"],
	["LICENSE-mldsa-native", "vendor/mldsa-native/LICENSE"],
	[shippedModule, "packages/ml-dsa/wasm/mldsa.wasm"],
]);

/**
 * The repository URL in the form that `npm pkg fix` writes. Trusted
 * publishing requires it to name this repository, and `npm publish` rewrites
 * any other form of it.
 */
export const repositoryUrl = "git+https://github.com/inkryptapp/ml-dsa.git";

/**
 * The largest tarball that the check accepts, in bytes. The tarball is about
 * 68 kB, so the limit leaves room for the README to grow. The pinned file
 * list catches an extra file, and the limit catches a shipped file that grows
 * by much, such as a bundle that inlines vector data.
 */
export const tarballLimit = 100_000;

/** The fields that would make the package resolve outside its exports map, or give it runtime dependencies. */
const forbiddenFields = [
	"main",
	"module",
	"types",
	"typings",
	"browser",
	"dependencies",
	"peerDependencies",
	"optionalDependencies",
	"bundleDependencies",
	"bundledDependencies",
];

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read(value: unknown, key: string): unknown {
	return isObject(value) ? Reflect.get(value, key) : undefined;
}

/**
 * Returns one message per rule that the shipped `package.json` breaks. It
 * must be an ES module package for Node 22 and newer, ship exactly
 * `expectedExports`, record the pin in `mldsaNative`, name this repository as
 * `repositoryUrl`, and have none of the `forbiddenFields`.
 */
export function manifestFailures(manifest: unknown): readonly string[] {
	const failures: string[] = [];
	if (!isObject(manifest)) {
		return ["package.json isn't a JSON object."];
	}
	if (read(manifest, "type") !== "module") {
		failures.push('package.json must set "type": "module".');
	}
	if (JSON.stringify(read(manifest, "engines")) !== JSON.stringify({ node: ">=22" })) {
		failures.push('package.json must set "engines" to exactly { "node": ">=22" }.');
	}
	if (JSON.stringify(read(manifest, "exports")) !== JSON.stringify(expectedExports)) {
		failures.push(
			`package.json must set "exports" to exactly ${JSON.stringify(expectedExports)}, in that key order.`,
		);
	}
	const pin = read(manifest, "mldsaNative");
	if (
		!isObject(pin) ||
		JSON.stringify(Object.keys(pin)) !== JSON.stringify(["tag", "commit"]) ||
		typeof read(pin, "tag") !== "string" ||
		typeof read(pin, "commit") !== "string"
	) {
		failures.push(
			'package.json must set "mldsaNative" to an object of exactly a "tag" and a "commit" string.',
		);
	}
	const url = read(read(manifest, "repository"), "url");
	if (url !== repositoryUrl) {
		failures.push(
			`package.json gives ${JSON.stringify(url)} as "repository.url" instead of ${JSON.stringify(repositoryUrl)}.`,
		);
	}
	for (const name of forbiddenFields) {
		if (Object.hasOwn(manifest, name)) {
			failures.push(`package.json has a "${name}" field, which the package must not have.`);
		}
	}
	return failures;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Returns one message per file that the tarball must not hold: a vector file,
 * found by its SHA-256 in `vectorHashes`, or the test-only entry point.
 */
export function forbiddenFileFailures(
	files: ReadonlyMap<string, Uint8Array>,
	vectorHashes: ReadonlyMap<string, string>,
): readonly string[] {
	const vectorsByHash = new Map([...vectorHashes].map(([file, hash]) => [hash, file]));
	return [...files].flatMap(([path, bytes]) => {
		const vector = vectorsByHash.get(sha256(bytes));
		if (vector !== undefined) {
			return [`The tarball holds ${path}, which is the vector file vectors/${vector}.`];
		}
		if (/(?:^|\/)testing(?:\.d)?\.[cm]?[jt]s$/.test(path)) {
			return [`The tarball holds ${path}, which is the test-only entry point.`];
		}
		return [];
	});
}

function stringValue(node: Node | null): string | null {
	if (node?.type !== "Literal") {
		return null;
	}
	const value = field(node, "value");
	return typeof value === "string" ? value : null;
}

/** What one import in a shipped file names. */
interface ModuleReference {
	/** The specifier, or `null` when the file computes it. */
	readonly specifier: string | null;
	/** Whether the import has attributes, such as `with { type: "json" }`. */
	readonly attributes: boolean;
	readonly start: number;
}

/**
 * The module each import, re-export, dynamic `import()`, `require()` call,
 * and type import in `source` names.
 */
function moduleReferences(file: string, source: string): readonly ModuleReference[] {
	return [...walk(parseProgram(file, source))].flatMap((node): readonly ModuleReference[] => {
		let target: Node | null = null;
		switch (node.type) {
			case "ImportDeclaration":
			case "ExportNamedDeclaration":
			case "ExportAllDeclaration":
			case "ImportExpression":
			case "TSImportType":
				target = child(node, "source");
				// An export of local bindings names no module.
				if (target === null && node.type === "ExportNamedDeclaration") {
					return [];
				}
				break;
			case "TSExternalModuleReference":
				target = child(node, "expression");
				break;
			case "CallExpression": {
				if (nameOf(child(node, "callee")) !== "require") {
					return [];
				}
				[target = null] = children(node, "arguments");
				break;
			}
			default:
				return [];
		}
		const attributes = field(node, "attributes") ?? field(node, "options");
		return [
			{
				specifier: stringValue(target),
				attributes: Array.isArray(attributes) ? attributes.length > 0 : isNode(attributes),
				start: node.start,
			},
		];
	});
}

function lineOf(source: string, offset: number): number {
	return source.slice(0, offset).split("\n").length;
}

/** A stand-in URL for the installed package folder, which relative imports resolve against. */
const packageRootUrl = new URL("file:///node_modules/ml-dsa/");

/**
 * Returns one message per import in a shipped file that could reach outside
 * the tarball or load JSON. Each import must name another file of the
 * tarball by a relative path, with no attributes, and no shipped file may
 * import a `.json` file. So the package has zero runtime dependencies, and
 * no shipped file imports noble, which the tests compare against.
 */
export function importFailures(
	file: string,
	source: string,
	files: ReadonlySet<string>,
): readonly string[] {
	// The URL of `file` under a package folder of its own, so that an import
	// that climbs out of the package resolves outside that folder.
	const base = new URL(file, packageRootUrl);
	return moduleReferences(file, source).flatMap(({ specifier, attributes, start }) => {
		const at = `${file}:${String(lineOf(source, start))}`;
		if (specifier === null) {
			return [`${at} imports a module whose name the file computes.`];
		}
		if (attributes) {
			return [`${at} imports "${specifier}" with import attributes, as a JSON import has.`];
		}
		if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
			return [
				`${at} imports "${specifier}", a package or a built-in module. The package has zero runtime dependencies, so it may import only its own files.`,
			];
		}
		const { pathname } = new URL(specifier, base);
		if (!pathname.startsWith(packageRootUrl.pathname)) {
			return [`${at} imports "${specifier}", which climbs out of the package folder.`];
		}
		const target = decodeURIComponent(pathname.slice(packageRootUrl.pathname.length));
		if (target.endsWith(".json")) {
			return [`${at} imports the JSON file "${specifier}". The pack build must inline it.`];
		}
		if (!files.has(target)) {
			return [`${at} imports "${specifier}", which the tarball doesn't hold.`];
		}
		return [];
	});
}

/**
 * Returns the module bytes that the default entry embeds: the base64 text of
 * its one `atob` call, either a string literal or the string that one
 * declaration binds to the call's argument.
 *
 * @returns The bytes, or a message that says why the check can't find them.
 */
export function embeddedModule(source: string): Uint8Array | string {
	const nodes = [...walk(parseProgram(defaultEntry, source))];
	const calls = nodes.filter(
		(node) => node.type === "CallExpression" && nameOf(child(node, "callee")) === "atob",
	);
	const [call] = calls;
	if (calls.length !== 1 || call === undefined) {
		return `${defaultEntry} calls atob ${String(calls.length)} times instead of once.`;
	}
	const [argument = null] = children(call, "arguments");
	let text = stringValue(argument);
	const name = nameOf(argument);
	if (text === null && name !== null) {
		const inits = nodes
			.filter((node) => node.type === "VariableDeclarator" && nameOf(child(node, "id")) === name)
			.map((node) => stringValue(child(node, "init")));
		const [init] = inits;
		text = inits.length === 1 && init !== undefined ? init : null;
	}
	if (text === null) {
		return `${defaultEntry} passes atob neither a string literal nor a name that one declaration binds to one.`;
	}
	if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
		return `${defaultEntry} passes atob text that isn't base64.`;
	}
	return Buffer.from(text, "base64");
}

function text(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("utf8");
}

/**
 * Returns the messages that say why the entries don't ship the same module:
 * the `workerd` entry must import only the raw `.wasm` file, and that file
 * must hold exactly the bytes that the default entry embeds.
 */
function twoEntryFailures(files: TarballFiles): readonly string[] {
	const workerd = files.get(workerdEntry);
	const index = files.get(defaultEntry);
	const wasm = files.get(shippedModule);
	if (workerd === undefined || index === undefined || wasm === undefined) {
		return [workerdEntry, defaultEntry, shippedModule]
			.filter((path) => !files.has(path))
			.map((path) => `The tarball lacks ${path}, so the check can't compare the entries' modules.`);
	}
	const failures: string[] = [];
	const imported = moduleReferences(workerdEntry, text(workerd)).map(({ specifier }) => specifier);
	if (JSON.stringify(imported) !== JSON.stringify(["./mldsa.wasm"])) {
		failures.push(
			`${workerdEntry} imports ${JSON.stringify(imported)} instead of only "./mldsa.wasm".`,
		);
	}
	const embedded = embeddedModule(text(index));
	if (typeof embedded === "string") {
		failures.push(embedded);
	} else if (Buffer.compare(embedded, wasm) !== 0) {
		failures.push(
			`The module that ${defaultEntry} embeds, SHA-256 ${sha256(embedded)}, differs from ${shippedModule}, SHA-256 ${sha256(wasm)}, which ${workerdEntry} imports.`,
		);
	}
	return failures;
}

/** What the package checks read, gathered by the check command. */
export interface PackageInputs {
	readonly files: TarballFiles;
	/** The tarball's own length in bytes. */
	readonly tarballBytes: number;
	/** The text of the committed file list, or `undefined` when the file is missing. */
	readonly committedList: string | undefined;
	/** The bytes of each repo file that `copiedFiles` names, or `undefined` when it's missing. */
	readonly repoFiles: ReadonlyMap<string, Uint8Array | undefined>;
	/** The SHA-256 of each vector file, keyed by its path in the `vectors` folder. */
	readonly vectorHashes: ReadonlyMap<string, string>;
	/** The patterns of the path scan. */
	readonly patterns: readonly ScanPattern[];
}

/** Runs every package check but attw, and returns one message per failure. */
export function packageFailures(inputs: PackageInputs): readonly string[] {
	const { files, patterns } = inputs;
	const paths = [...files.keys()].toSorted();
	const failures = [
		...snapshotFailures(tarballFilesFile, "the tarball", inputs.committedList, paths),
	];
	if (inputs.tarballBytes > tarballLimit) {
		failures.push(
			`The tarball is ${String(inputs.tarballBytes)} bytes, over the limit of ${String(tarballLimit)}.`,
		);
	}
	for (const [path, repoPath] of copiedFiles) {
		const shipped = files.get(path);
		const source = inputs.repoFiles.get(repoPath);
		if (shipped !== undefined && (source === undefined || Buffer.compare(shipped, source) !== 0)) {
			failures.push(
				`The tarball's ${path} differs from ${repoPath}, which the pack copies unchanged.`,
			);
		}
	}
	const manifest = files.get("package.json");
	if (manifest !== undefined) {
		let parsed: unknown = undefined;
		try {
			parsed = JSON.parse(text(manifest));
		} catch {
			failures.push("The tarball's package.json isn't valid JSON.");
		}
		if (parsed !== undefined) {
			failures.push(...manifestFailures(parsed));
		}
	}
	failures.push(...forbiddenFileFailures(files, inputs.vectorHashes));
	const fileSet = new Set(paths);
	for (const path of paths.filter((candidate) => /\.(?:js|d\.ts)$/.test(candidate))) {
		failures.push(...importFailures(path, text(files.get(path) ?? new Uint8Array()), fileSet));
	}
	failures.push(...twoEntryFailures(files));
	for (const path of entryFiles) {
		const source = files.get(path);
		if (source !== undefined) {
			failures.push(...coreStructureFailures(path, text(source)));
		}
	}
	for (const path of paths.filter((candidate) => candidate.startsWith("dist/"))) {
		failures.push(...hostPathFailures(path, files.get(path) ?? new Uint8Array(), patterns));
	}
	const index = files.get(defaultEntry);
	const embedded = index === undefined ? undefined : embeddedModule(text(index));
	if (embedded !== undefined && typeof embedded !== "string") {
		failures.push(
			...hostPathFailures(`The module that ${defaultEntry} embeds`, embedded, patterns),
		);
	}
	return failures;
}

/**
 * Runs attw, the binary at `attw`, on the tarball at `tarball`, and returns a
 * message with attw's report when it finds a problem.
 */
export function attwFailures(attw: string, tarball: string): readonly string[] {
	const args = [tarball, "--profile", "esm-only"];
	const result = spawnSync(attw, args, { encoding: "utf8" });
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		return [`\`attw ${args.join(" ")}\` reports a problem:\n${result.stdout}${result.stderr}`];
	}
	return [];
}
