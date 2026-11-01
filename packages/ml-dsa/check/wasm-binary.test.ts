import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { readModule, readProducers, WasmFormatError } from "./wasm-binary.ts";
import {
	customSection,
	functionType,
	name,
	producersSection,
	s32,
	section,
	u32,
	valueType,
	vector,
	wasmModule,
} from "./wasm-fixtures.ts";

interface Descriptor {
	readonly name: string;
	readonly kind: string;
}

// The workspace's types declare no `WebAssembly`, so the test declares the
// part that it calls.
declare const WebAssembly: {
	readonly Module: {
		new (bytes: Uint8Array): object;
		exports(module: object): Descriptor[];
		imports(module: object): Descriptor[];
	};
};

const { i32, i64, funcref } = valueType;

/** A module with one item of every kind that the reader decodes. */
const everySection = wasmModule(
	section(1, vector([functionType([i32, i32, i32], []), functionType([i32], [i32])])),
	section(
		2,
		vector([
			[...name("env"), ...name("log"), 0x00, ...u32(0)],
			[...name("env"), ...name("base"), 0x03, i32, 0x00],
		]),
	),
	section(3, vector([u32(1)])),
	section(4, vector([[funcref, 0x01, ...u32(1), ...u32(2)]])),
	section(5, vector([[0x01, ...u32(2), ...u32(3)]])),
	section(
		6,
		vector([
			[i32, 0x01, 0x41, ...s32(-5), 0x0b],
			[i64, 0x00, 0x42, ...s32(7), 0x0b],
			[i32, 0x00, 0x23, ...u32(0), 0x0b],
		]),
	),
	section(
		7,
		vector([
			[...name("f"), 0x00, ...u32(1)],
			[...name("m"), 0x02, ...u32(0)],
			[...name("g"), 0x03, ...u32(1)],
			[...name("t"), 0x01, ...u32(0)],
		]),
	),
	section(10, vector([[...u32(4), 0x00, 0x20, 0x00, 0x0b]])),
	producersSection([["processed-by", [["clang", "22.1.5"]]]]),
);

/** The reader's format error for `bytes`, or `undefined` if it reads them. */
function readError(bytes: Uint8Array): string | undefined {
	try {
		readModule(bytes);
	} catch (error) {
		if (error instanceof WasmFormatError) {
			return error.message;
		}
		throw error;
	}
	return undefined;
}

describe("readModule", () => {
	test("reads every section that it decodes, and skips the code section", () => {
		expect(readModule(everySection)).toStrictEqual({
			types: [
				{ params: ["i32", "i32", "i32"], results: [] },
				{ params: ["i32"], results: ["i32"] },
			],
			imports: [
				{ module: "env", name: "log", kind: "func", typeIndex: 0 },
				{ module: "env", name: "base", kind: "global", type: { valueType: "i32", mutable: false } },
			],
			functions: [1],
			tables: [{ min: 1, max: 2, shared: false }],
			memories: [{ min: 2, max: 3, shared: false }],
			globals: [
				{ type: { valueType: "i32", mutable: true }, i32Value: -5 },
				{ type: { valueType: "i64", mutable: false }, i32Value: undefined },
				{ type: { valueType: "i32", mutable: false }, i32Value: undefined },
			],
			exports: [
				{ name: "f", kind: "func", index: 1 },
				{ name: "m", kind: "memory", index: 0 },
				{ name: "g", kind: "global", index: 1 },
				{ name: "t", kind: "table", index: 0 },
			],
			customSections: [
				{
					name: "producers",
					bytes: new Uint8Array(
						producersSection([["processed-by", [["clang", "22.1.5"]]]]).slice(12),
					),
				},
			],
		});
	});

	test("reads the names and kinds of the committed module's exports and imports as V8 does", () => {
		const bytes = readFileSync(join(root, "packages/ml-dsa/wasm/mldsa.wasm"));
		const v8 = new WebAssembly.Module(bytes);
		const module = readModule(bytes);
		const kinds = { func: "function", table: "table", memory: "memory", global: "global" };
		expect(
			module.exports.map((entry) => ({ name: entry.name, kind: kinds[entry.kind] })),
		).toStrictEqual(WebAssembly.Module.exports(v8));
		expect(module.imports).toStrictEqual(WebAssembly.Module.imports(v8));
	});

	test("rejects bytes without the magic number and version 1", () => {
		expect(readError(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]))).toBe(
			"At byte 0: the module doesn't start with the wasm magic number and version 1.",
		);
		expect(readError(new Uint8Array([0x00, 0x61]))).toBe(
			"At byte 0: the module doesn't start with the wasm magic number and version 1.",
		);
	});

	test("rejects a section out of order, a repeated section, and an unknown section", () => {
		const memory = section(5, vector([[0x00, ...u32(1)]]));
		expect(readError(wasmModule(memory, section(1, vector([]))))).toBe(
			"At byte 13: the section id 1 is out of order or repeated.",
		);
		expect(readError(wasmModule(memory, memory))).toBe(
			"At byte 13: the section id 5 is out of order or repeated.",
		);
		expect(readError(wasmModule(section(14, [])))).toBe("At byte 8: the section id 14 is unknown.");
		// The tag section of exception handling isn't part of the MVP.
		expect(readError(wasmModule(section(13, [])))).toBe("At byte 8: the section id 13 is unknown.");
	});

	test("accepts custom sections anywhere", () => {
		const memory = section(5, vector([[0x00, ...u32(1)]]));
		const custom = customSection("note", [1, 2]);
		expect(readModule(wasmModule(custom, memory, custom)).customSections).toStrictEqual([
			{ name: "note", bytes: new Uint8Array([1, 2]) },
			{ name: "note", bytes: new Uint8Array([1, 2]) },
		]);
	});

	test("rejects a section whose contents end before its declared size", () => {
		expect(readError(wasmModule(section(3, [...vector([u32(0)]), 0x00])))).toBe(
			"At byte 8: the section id 3 declares 3 bytes, but its contents end at byte 12.",
		);
	});

	test("rejects a section that runs past the end of the bytes", () => {
		expect(readError(wasmModule([3, ...u32(5), 0x01]))).toBe(
			"At byte 10: 5 bytes run past the end.",
		);
	});

	test("rejects contents that run past their section", () => {
		expect(readError(wasmModule(section(3, vector([u32(0), u32(1)]).slice(0, 2))))).toBe(
			"At byte 12: the bytes end early.",
		);
	});

	test("rejects an unsigned LEB128 number past 32 bits", () => {
		expect(readError(wasmModule(section(3, [0x01, 0xff, 0xff, 0xff, 0xff, 0x1f])))).toBe(
			"At byte 11: an unsigned LEB128 number runs past 32 bits.",
		);
		expect(
			readModule(wasmModule(section(3, [0x01, 0xff, 0xff, 0xff, 0xff, 0x0f]))).functions,
		).toStrictEqual([2 ** 32 - 1]);
	});

	test("rejects a signed LEB128 number past 32 bits", () => {
		const global = (constant: readonly number[]): Uint8Array =>
			wasmModule(section(6, vector([[i32, 0x00, 0x41, ...constant, 0x0b]])));
		expect(readError(global([0x80, 0x80, 0x80, 0x80, 0x08]))).toBe(
			"At byte 14: a signed LEB128 number runs past 32 bits.",
		);
		expect(readModule(global(s32(-(2 ** 31)))).globals[0]?.i32Value).toBe(-(2 ** 31));
	});

	test("rejects a value type, kind, table type, or limits flag outside the MVP", () => {
		for (const code of [0x40, 0x7b, 0x70]) {
			expect(readError(wasmModule(section(1, vector([[0x60, 0x01, code, 0x00]]))))).toBe(
				`At byte 13: the value type 0x${code.toString(16)} is unknown.`,
			);
		}
		expect(readError(wasmModule(section(7, vector([[...name("x"), 0x04, 0x00]]))))).toBe(
			"At byte 13: an export's kind is unknown.",
		);
		expect(readError(wasmModule(section(4, vector([[0x6f, 0x00, 0x01]]))))).toBe(
			"At byte 11: the table element type 0x6f isn't funcref.",
		);
		expect(readError(wasmModule(section(4, vector([[0x70, 0x03, 0x01, 0x01]]))))).toBe(
			"At byte 12: the limits flags 0x3 are unknown.",
		);
		expect(readError(wasmModule(section(5, vector([[0x04, 0x01]]))))).toBe(
			"At byte 11: the limits flags 0x4 are unknown.",
		);
	});

	test("rejects a function type with more than one result, which the MVP forbids", () => {
		expect(readError(wasmModule(section(1, vector([[0x60, 0x00, 0x02, i32, i32]]))))).toBe(
			"At byte 13: a function type has more than one result, which the MVP forbids.",
		);
	});

	test("rejects a 64-bit constant whose LEB128 number runs past 64 bits", () => {
		const constant = (number: readonly number[]): Uint8Array =>
			wasmModule(section(6, vector([[i64, 0x00, 0x42, ...number, 0x0b]])));
		const nine = Array<number>(9).fill(0x80);
		for (const tenth of [0x80, 0x02, 0x7e]) {
			expect(readError(constant([...nine, tenth, 0x00]))).toBe(
				"At byte 14: a signed LEB128 number runs past 64 bits.",
			);
		}
		// The smallest and the largest 64-bit values end in 0x7f and 0x00.
		expect(readError(constant([...nine, 0x7f]))).toBeUndefined();
		expect(readError(constant([...Array<number>(9).fill(0xff), 0x00]))).toBeUndefined();
	});

	test("keeps a leading U+FEFF in a name", () => {
		const module = readModule(
			wasmModule(section(7, vector([[...name("\uFEFFmemory"), 0x02, 0x00]]))),
		);
		expect(module.exports.map((entry) => entry.name)).toStrictEqual(["\uFEFFmemory"]);
	});

	test("rejects a name that isn't valid UTF-8", () => {
		expect(readError(wasmModule(section(7, vector([[0x01, 0xff, 0x00, 0x00]]))))).toBe(
			"At byte 11: a name isn't valid UTF-8.",
		);
	});

	test("rejects an instruction that an MVP constant expression can't hold", () => {
		expect(readError(wasmModule(section(6, vector([[i32, 0x00, 0x20, 0x00, 0x0b]]))))).toBe(
			"At byte 13: the opcode 0x20 can't appear in a constant expression.",
		);
		expect(readError(wasmModule(section(6, vector([[i32, 0x00, 0xd2, 0x00, 0x0b]]))))).toBe(
			"At byte 13: the opcode 0xd2 can't appear in a constant expression.",
		);
		const extendedConst = [i32, 0x00, 0x41, 0x01, 0x41, 0x02, 0x6a, 0x0b];
		expect(readError(wasmModule(section(6, vector([extendedConst]))))).toBe(
			"At byte 17: the opcode 0x6a can't appear in a constant expression.",
		);
	});
});

describe("readProducers", () => {
	test("reads each field with its tools in order", () => {
		const bytes = new Uint8Array(
			producersSection([
				["language", [["C11", ""]]],
				[
					"processed-by",
					[
						["clang", "22.1.5"],
						["wasm-opt", "123"],
					],
				],
			]).slice(12),
		);
		expect(readProducers(bytes)).toStrictEqual(
			new Map([
				["language", [{ name: "C11", version: "" }]],
				[
					"processed-by",
					[
						{ name: "clang", version: "22.1.5" },
						{ name: "wasm-opt", version: "123" },
					],
				],
			]),
		);
	});

	test("rejects a repeated field and bytes after the last field", () => {
		const field = [...name("sdk"), ...vector([])];
		expect(() => readProducers(new Uint8Array(vector([field, field])))).toThrow(
			'At byte 11: the producers section names the field "sdk" twice.',
		);
		expect(() => readProducers(new Uint8Array([...vector([field]), 0x00]))).toThrow(
			"At byte 6: the producers section has bytes after its last field.",
		);
	});
});
