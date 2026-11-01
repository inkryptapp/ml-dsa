import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { toolTimeout } from "../test/dev-tools.ts";
import {
	declarationFailures,
	exportEntries,
	exportLine,
	exportListFile,
	importAndMemoryFailures,
	sizeFailures,
	type ExportEntry,
} from "./module-interface.ts";
import { snapshotFailures } from "./snapshot.ts";
import { readModule, WasmFormatError } from "./wasm-binary.ts";
import {
	functionType,
	name,
	s32,
	section,
	u32,
	valueType,
	vector,
	wasmModule,
} from "./wasm-fixtures.ts";

const { i32, i64, funcref } = valueType;

const committedModule = readModule(readFileSync(join(root, "packages/ml-dsa/wasm/mldsa.wasm")));
const committedEntries = exportEntries(committedModule);

/**
 * A module that imports a function and a global, defines a function, a table,
 * a memory, and a global, and exports all six.
 */
const fixture = readModule(
	wasmModule(
		section(1, vector([functionType([i32, i64], [i32]), functionType([], [])])),
		section(
			2,
			vector([
				[...name("env"), ...name("log"), 0x00, ...u32(1)],
				[...name("env"), ...name("base"), 0x03, i32, 0x00],
			]),
		),
		section(3, vector([u32(0)])),
		section(4, vector([[funcref, 0x00, ...u32(1)]])),
		section(5, vector([[0x03, ...u32(1), ...u32(4)]])),
		section(6, vector([[i64, 0x01, 0x42, ...s32(0), 0x0b]])),
		section(
			7,
			vector([
				[...name("imported"), 0x00, ...u32(0)],
				[...name("defined"), 0x00, ...u32(1)],
				[...name("table"), 0x01, ...u32(0)],
				[...name("memory"), 0x02, ...u32(0)],
				[...name("base"), 0x03, ...u32(0)],
				[...name("counter"), 0x03, ...u32(1)],
			]),
		),
	),
);

describe("the export list", () => {
	test("of the committed module equals the committed list", () => {
		const committed = readFileSync(join(root, exportListFile), "utf8");
		expect(
			snapshotFailures(
				exportListFile,
				"the committed module",
				committed,
				committedEntries.map(exportLine),
			),
		).toStrictEqual([]);
	});

	test("renders each kind with its type, through imports and definitions alike", () => {
		expect(exportEntries(fixture).map(exportLine)).toStrictEqual([
			"imported: func () -> ()",
			"defined: func (i32, i64) -> (i32)",
			"table: table (funcref, min 1, no max)",
			"memory: memory (min 1 pages, max 4 pages, shared)",
			"base: global (i32, immutable)",
			"counter: global (i64, mutable)",
		]);
	});

	test("rejects an export of an item that doesn't exist", () => {
		const module = readModule(wasmModule(section(7, vector([[...name("f"), 0x00, ...u32(0)]]))));
		expect(() => exportEntries(module)).toThrow(
			new WasmFormatError("The module refers to function 0, which doesn't exist."),
		);
	});
});

describe("importAndMemoryFailures", () => {
	test("passes the committed module, which imports nothing and can't grow", () => {
		expect(importAndMemoryFailures(committedModule)).toStrictEqual([]);
	});

	test("fails on each import, and on a memory whose maximum isn't its initial size", () => {
		expect(importAndMemoryFailures(fixture)).toStrictEqual([
			'packages/ml-dsa/wasm/mldsa.wasm imports the func "log" from "env", but it must import nothing.',
			'packages/ml-dsa/wasm/mldsa.wasm imports the global "base" from "env", but it must import nothing.',
			"Memory 0 of packages/ml-dsa/wasm/mldsa.wasm has min 1 pages, max 4 pages, but its initial size must equal its maximum, so it can't grow.",
		]);
		const growable = readModule(wasmModule(section(5, vector([[0x00, ...u32(5)]]))));
		expect(importAndMemoryFailures(growable)).toStrictEqual([
			"Memory 0 of packages/ml-dsa/wasm/mldsa.wasm has min 5 pages, no max, but its initial size must equal its maximum, so it can't grow.",
		]);
	});
});

describe("sizeFailures", () => {
	const sizes = { memoryBytes: 327_680, stackBytes: 196_608 };

	test("passes the committed module with the committed sizes", () => {
		expect(sizeFailures(committedModule, sizes)).toStrictEqual([]);
	});

	test("fails when the memory, __heap_end, or the wasm stack differs from the sizes", () => {
		expect(
			sizeFailures(committedModule, { memoryBytes: 393_216, stackBytes: 131_072 }),
		).toStrictEqual([
			"The memory of packages/ml-dsa/wasm/mldsa.wasm spans 327680 bytes, but sizes.json gives 393216.",
			"__heap_end in packages/ml-dsa/wasm/mldsa.wasm is 327680, but it must equal the memory size, 393216 bytes in sizes.json.",
			"__stack_high minus __stack_low in packages/ml-dsa/wasm/mldsa.wasm is 196608, but it must equal the wasm stack size, 131072 bytes in sizes.json.",
		]);
	});

	test("reads each size global past the imported globals in the global index space", () => {
		const constant = (value: number): number[] => [i32, 0x00, 0x41, ...s32(value), 0x0b];
		const module = readModule(
			wasmModule(
				section(2, vector([[...name("env"), ...name("base"), 0x03, i32, 0x00]])),
				section(5, vector([[0x01, ...u32(5), ...u32(5)]])),
				section(6, vector([constant(0), constant(196_608), constant(327_680)])),
				section(
					7,
					vector([
						[...name("__stack_low"), 0x03, ...u32(1)],
						[...name("__stack_high"), 0x03, ...u32(2)],
						[...name("__heap_end"), 0x03, ...u32(3)],
						[...name("base"), 0x03, ...u32(0)],
					]),
				),
			),
		);
		expect(sizeFailures(module, sizes)).toStrictEqual([]);
	});

	test("fails when a size global is missing, mutable, or not an i32.const", () => {
		const module = readModule(
			wasmModule(
				section(5, vector([[0x01, ...u32(5), ...u32(5)]])),
				section(
					6,
					vector([
						[i32, 0x01, 0x41, ...s32(0), 0x0b],
						[i32, 0x00, 0x23, ...u32(0), 0x0b],
					]),
				),
				section(
					7,
					vector([
						[...name("__stack_low"), 0x03, ...u32(0)],
						[...name("__stack_high"), 0x03, ...u32(1)],
					]),
				),
			),
		);
		const global = (globalName: string): string =>
			`packages/ml-dsa/wasm/mldsa.wasm must export ${globalName} as an immutable i32 global with an i32.const initializer.`;
		expect(sizeFailures(module, sizes)).toStrictEqual([
			global("__heap_end"),
			global("__stack_low"),
			global("__stack_high"),
		]);
	});
});

describe("declarationFailures", { timeout: toolTimeout }, () => {
	test("passes the declaration in src/module-exports.ts against the committed module", () => {
		expect(declarationFailures(root, committedEntries)).toStrictEqual([]);
	});

	test("names each export whose declaration differs from its wasm type", () => {
		const changed = (entryName: string, change: Partial<ExportEntry>): ExportEntry => {
			const entry = committedEntries.find((item) => item.name === entryName);
			if (entry === undefined) {
				throw new Error(`The committed module has no export ${entryName}.`);
			}
			return Object.assign({}, entry, change);
		};
		const entries: ExportEntry[] = [
			...committedEntries.filter(
				(entry) =>
					![
						"mldsa_shake256_absorb",
						"mldsa_shake256_init",
						"mldsa44_verify_extmu",
						"mldsa65_verify_extmu",
						"__heap_end",
						"memory",
						"mldsa_shake256_release",
					].includes(entry.name),
			),
			// One parameter fewer, a result where the declaration returns void,
			// an i64 parameter that the declaration types as a number, and no
			// result where the declaration returns a number.
			changed("mldsa_shake256_absorb", { type: { params: ["i32", "i32"], results: [] } }),
			changed("mldsa_shake256_init", { type: { params: ["i32"], results: ["i32"] } }),
			changed("mldsa44_verify_extmu", {
				type: { params: ["i32", "i32", "i64"], results: ["i32"] },
			}),
			changed("mldsa65_verify_extmu", { type: { params: ["i32", "i32", "i32"], results: [] } }),
			// A mutable global and a shared memory.
			changed("__heap_end", { type: { valueType: "i32", mutable: true } }),
			changed("memory", { limits: { min: 5, max: 5, shared: true } }),
			// An export that the declaration lacks, in place of one that it has.
			{ name: "mldsa_shake256_reset", kind: "func", type: { params: ["i32"], results: [] } },
		];
		const [failure = "", ...rest] = declarationFailures(root, entries);
		expect(rest).toStrictEqual([]);
		const [header, ...typeScriptLines] = failure.split("\n");
		expect(header).toBe(
			"The declaration of the raw exports in packages/ml-dsa/src/module-exports.ts doesn't match the module's exports in packages/ml-dsa/check/module-exports.txt. In the generated check, TypeScript names each export whose declaration is missing or differs, and \"the export names\" when the declaration and the module name different exports:",
		);
		// TypeScript prints the failed names as one union, in an order of its own.
		expect(typeScriptLines).toHaveLength(1);
		const union = /is not assignable to type '(.+)'\.$/.exec(typeScriptLines[0] ?? "")?.[1];
		expect(union?.split(" | ").toSorted()).toStrictEqual(
			[
				"mldsa_shake256_absorb",
				"mldsa_shake256_init",
				"mldsa44_verify_extmu",
				"mldsa65_verify_extmu",
				"__heap_end",
				"memory",
				"mldsa_shake256_reset",
				"the export names",
			]
				.map((exportName) => JSON.stringify(exportName))
				.toSorted(),
		);
	});
});
