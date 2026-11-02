import { describe, expect, test } from "vite-plus/test";

import {
	debugInfoFailures,
	hostPathFailures,
	negativeFixtureFailures,
	prefixMapNames,
	scanPatterns,
	type HostRoot,
} from "./host-paths.ts";
import { readModule } from "./wasm-binary.ts";
import { customSection, wasmModule } from "./wasm-fixtures.ts";

const roots: readonly HostRoot[] = [
	{ name: "the build folder", path: "/nix/var/nix/builds/nix-1-2488162672" },
	{
		name: "the vendored source",
		path: "/nix/store/fkpscrjsrm6fypn0r5h62xj1fmgqsmw7-mldsa-native",
	},
	{
		name: "clang's resource folder",
		path: "/nix/store/h18sjjpd90gbb45f45jrc69bh9dwakab-clang-22.1.5-lib/lib/clang/22",
	},
];

const encode = (text: string): number[] => [...new TextEncoder().encode(text)];

describe("scanPatterns", () => {
	test("lists the generic host prefixes, each root, and the store hash of each root in the store", () => {
		expect(scanPatterns(roots)).toStrictEqual([
			{ text: "/nix/store", what: "a generic host prefix" },
			{ text: "/nix/var", what: "a generic host prefix" },
			{ text: "/build", what: "a generic host prefix" },
			{ text: "/tmp", what: "a generic host prefix" },
			{ text: "/home", what: "a generic host prefix" },
			{ text: "/root", what: "a generic host prefix" },
			{ text: "/Users", what: "a generic host prefix" },
			{ text: "/private", what: "a generic host prefix" },
			{ text: "/var/folders", what: "a generic host prefix" },
			{ text: "/nix/var/nix/builds/nix-1-2488162672", what: "the build folder" },
			{
				text: "/nix/store/fkpscrjsrm6fypn0r5h62xj1fmgqsmw7-mldsa-native",
				what: "the vendored source",
			},
			{ text: "fkpscrjsrm6fypn0r5h62xj1fmgqsmw7", what: "the store hash of the vendored source" },
			{
				text: "/nix/store/h18sjjpd90gbb45f45jrc69bh9dwakab-clang-22.1.5-lib/lib/clang/22",
				what: "clang's resource folder",
			},
			{
				text: "h18sjjpd90gbb45f45jrc69bh9dwakab",
				what: "the store hash of clang's resource folder",
			},
		]);
	});
});

describe("hostPathFailures", () => {
	const patterns = scanPatterns(roots);

	test("passes on bytes that name no host path", () => {
		const bytes = new Uint8Array([
			0x00,
			...encode("mldsa-native/mldsa/src/sign.c"),
			0x00,
			...encode("build"),
		]);
		expect(hostPathFailures("the module", bytes, patterns)).toStrictEqual([]);
	});

	test("reports each pattern with its count and first offset", () => {
		const bytes = new Uint8Array([
			...encode("xx/tmp/a"),
			0x00,
			...encode("/tmp/b"),
			...encode("fkpscrjsrm6fypn0r5h62xj1fmgqsmw7"),
		]);
		expect(hostPathFailures("the module", bytes, patterns)).toStrictEqual([
			'the module holds "/tmp", a generic host prefix, 2 times, first at byte 2.',
			'the module holds "fkpscrjsrm6fypn0r5h62xj1fmgqsmw7", the store hash of the vendored source, 1 time, first at byte 15.',
		]);
	});
});

describe("negativeFixtureFailures", () => {
	test("passes when the scan finds every pattern in the fixture", () => {
		expect(negativeFixtureFailures(scanPatterns(roots))).toStrictEqual([]);
	});
});

describe("prefixMapNames", () => {
	test("reads the name that each prefix map gives its root", () => {
		const script = [
			"prefix_maps=(",
			'\t"-ffile-prefix-map=$PWD=build"',
			'\t"-ffile-prefix-map=$MLDSA_NATIVE=mldsa-native"',
			'\t"-ffile-prefix-map=$("$CC" -print-resource-dir)=clang"',
			")",
		].join("\n");
		expect(prefixMapNames(script)).toStrictEqual(["build", "mldsa-native", "clang"]);
	});
});

describe("debugInfoFailures", () => {
	/** A `.debug_str` section that holds `strings`, each ending in a zero byte. */
	const debugStrings = (...strings: readonly string[]): number[] =>
		customSection(
			".debug_str",
			strings.flatMap((text) => [...encode(text), 0x00]),
		);
	const names = ["build", "mldsa-native", "include", "clang"];

	test("passes when the debug info names a path under each map's name", () => {
		const module = readModule(
			wasmModule(
				debugStrings("build", "mldsa-native/mldsa/src/sign.c", "include", "clang/include"),
				customSection(".debug_line", [0x05, 0x00, ...encode("stdint.h"), 0x00]),
			),
		);
		expect(debugInfoFailures(module, names)).toStrictEqual([]);
	});

	test("fails without a debug section", () => {
		expect(
			debugInfoFailures(readModule(wasmModule(customSection("name", []))), names),
		).toStrictEqual([
			"The -g build has no .debug_* section, so its scan can't prove the prefix maps.",
		]);
	});

	test("fails on a map whose name no path in the debug info starts with", () => {
		const module = readModule(
			wasmModule(debugStrings("builder", "mldsa-native/mldsa/src/sign.c", "clang/include/include")),
		);
		expect(debugInfoFailures(module, names)).toStrictEqual([
			"The -g build's debug info names no path that starts with \"build\", so the scan can't prove the map to it.",
			"The -g build's debug info names no path that starts with \"include\", so the scan can't prove the map to it.",
		]);
	});
});
