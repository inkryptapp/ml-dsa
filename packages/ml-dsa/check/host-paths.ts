/**
 * The path scan. The module's bytes must name no host path: no generic host
 * prefix, none of the roots that the build reads, and none of those roots'
 * store hashes. The shipped module has no debug info, so a clean scan of it
 * alone would prove little. So the check also scans a -g build, linked
 * without `--strip-all` and `--strip-debug`, whose debug info names every
 * root that the compile reads unless a prefix map in `build.sh` renames it. A
 * negative fixture that holds each pattern proves that the scan finds them.
 * Both derivations set `allowedReferences = [ ]`, so Nix already fails a
 * build whose output names a store path that the build reads. The scan also
 * covers the build folder and the generic prefixes, which Nix doesn't check.
 *
 * The scan catches a path that a build change leaks by accident. It reads
 * plain bytes, so it misses a path that the build encodes on purpose, and
 * review covers that.
 */
import type { WasmModule } from "./wasm-binary.ts";
import { customSection, wasmModule } from "./wasm-fixtures.ts";

/** A folder that the build reads, which the check computes for the build it scans. */
export interface HostRoot {
	/** What the folder is, such as "the vendored source". */
	readonly name: string;
	readonly path: string;
}

/** A byte string that the scan looks for, and what it stands for. */
export interface ScanPattern {
	readonly text: string;
	readonly what: string;
}

/** The starts of host paths on the Linux build container and on developer hosts. */
const genericPrefixes = [
	"/nix/store",
	"/nix/var",
	"/build",
	"/tmp",
	"/home",
	"/root",
	"/Users",
	"/private",
	"/var/folders",
];

/** The patterns for `roots`: the generic prefixes, then each root and its store hash, if it has one. */
export function scanPatterns(roots: readonly HostRoot[]): readonly ScanPattern[] {
	return [
		...genericPrefixes.map((text) => ({ text, what: "a generic host prefix" })),
		...roots.flatMap(({ name, path }) => {
			const hash = /^\/nix\/store\/([0-9a-z]{32})-/.exec(path)?.[1];
			return [
				{ text: path, what: name },
				...(hash === undefined ? [] : [{ text: hash, what: `the store hash of ${name}` }]),
			];
		}),
	];
}

/**
 * The bytes as a string of one character per byte. So string offsets are
 * byte offsets, and an ASCII pattern matches only its own bytes.
 */
function latin1(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Each offset in `bytes` at which `text` starts. */
function offsets(bytes: Uint8Array, text: string): readonly number[] {
	const haystack = latin1(bytes);
	const found: number[] = [];
	for (let at = haystack.indexOf(text); at !== -1; at = haystack.indexOf(text, at + 1)) {
		found.push(at);
	}
	return found;
}

/** Returns one message per pattern that `bytes`, which `subject` names, hold. */
export function hostPathFailures(
	subject: string,
	bytes: Uint8Array,
	patterns: readonly ScanPattern[],
): readonly string[] {
	return patterns.flatMap(({ text, what }) => {
		const found = offsets(bytes, text);
		const [first] = found;
		if (first === undefined) {
			return [];
		}
		const times = found.length === 1 ? "1 time" : `${String(found.length)} times`;
		return [`${subject} holds "${text}", ${what}, ${times}, first at byte ${String(first)}.`];
	});
}

/**
 * Scans a module whose custom section holds each pattern, as debug info
 * would, and returns one message per pattern that the scan misses.
 */
export function negativeFixtureFailures(patterns: readonly ScanPattern[]): readonly string[] {
	const encoder = new TextEncoder();
	const strings = patterns.flatMap(({ text }) => [...encoder.encode(`${text}/x.c`), 0x00]);
	const fixture = wasmModule(customSection(".debug_str", strings));
	const reported = hostPathFailures("the fixture", fixture, patterns);
	return patterns
		.filter(({ text }) => !reported.some((message) => message.includes(`"${text}"`)))
		.map(
			({ text, what }) =>
				`The scan misses "${text}", ${what}, in its negative fixture, so a clean scan proves nothing about it.`,
		);
}

/** The name that each `-ffile-prefix-map=ROOT=NAME` in the build script gives its root, in order. */
export function prefixMapNames(buildScript: string): readonly string[] {
	return [...buildScript.matchAll(/-ffile-prefix-map=[^=\n]+=([\w.-]+)"/g)].flatMap(
		(match) => match[1] ?? [],
	);
}

/** The printable text before each zero byte of `bytes`, which is how DWARF stores its strings. */
function zeroTerminatedStrings(bytes: Uint8Array): readonly string[] {
	return latin1(bytes)
		.split("\u0000")
		.map((part) => /[\x20-\x7e]*$/.exec(part)?.[0] ?? "");
}

/**
 * Returns the messages that say why a -g build can't prove the prefix maps:
 * it has no `.debug_*` section, or its debug info names no path under the
 * name of one of the maps, so that map may not have run.
 */
export function debugInfoFailures(
	module: WasmModule,
	mapNames: readonly string[],
): readonly string[] {
	const debug = module.customSections.filter((section) => section.name.startsWith(".debug_"));
	if (debug.length === 0) {
		return ["The -g build has no .debug_* section, so its scan can't prove the prefix maps."];
	}
	const strings = debug.flatMap((section) => zeroTerminatedStrings(section.bytes));
	return mapNames
		.filter((name) => !strings.some((text) => text === name || text.startsWith(`${name}/`)))
		.map(
			(name) =>
				`The -g build's debug info names no path that starts with "${name}", so the scan can't prove the map to it.`,
		);
}
