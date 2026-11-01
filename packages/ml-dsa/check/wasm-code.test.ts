import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { moduleFile } from "./files.ts";
import { readModule, WasmFormatError } from "./wasm-binary.ts";
import { decodeFunctionBodies } from "./wasm-code.ts";
import { functionType, s32, section, u32, valueType, vector, wasmModule } from "./wasm-fixtures.ts";

/** One instruction of a fixture: its encoding, written out by hand, and what the decoder must read from it. */
type Written = readonly [
	bytes: readonly number[],
	name: string,
	immediates?: readonly (number | bigint)[],
];

/** The instructions that take no immediate, one opcode byte each, from 0x45 to 0xbf. */
const numeric: readonly Written[] = (
	[
		[0x45, "i32.eqz"],
		[0x46, "i32.eq"],
		[0x47, "i32.ne"],
		[0x48, "i32.lt_s"],
		[0x49, "i32.lt_u"],
		[0x4a, "i32.gt_s"],
		[0x4b, "i32.gt_u"],
		[0x4c, "i32.le_s"],
		[0x4d, "i32.le_u"],
		[0x4e, "i32.ge_s"],
		[0x4f, "i32.ge_u"],
		[0x50, "i64.eqz"],
		[0x51, "i64.eq"],
		[0x52, "i64.ne"],
		[0x53, "i64.lt_s"],
		[0x54, "i64.lt_u"],
		[0x55, "i64.gt_s"],
		[0x56, "i64.gt_u"],
		[0x57, "i64.le_s"],
		[0x58, "i64.le_u"],
		[0x59, "i64.ge_s"],
		[0x5a, "i64.ge_u"],
		[0x5b, "f32.eq"],
		[0x5c, "f32.ne"],
		[0x5d, "f32.lt"],
		[0x5e, "f32.gt"],
		[0x5f, "f32.le"],
		[0x60, "f32.ge"],
		[0x61, "f64.eq"],
		[0x62, "f64.ne"],
		[0x63, "f64.lt"],
		[0x64, "f64.gt"],
		[0x65, "f64.le"],
		[0x66, "f64.ge"],
		[0x67, "i32.clz"],
		[0x68, "i32.ctz"],
		[0x69, "i32.popcnt"],
		[0x6a, "i32.add"],
		[0x6b, "i32.sub"],
		[0x6c, "i32.mul"],
		[0x6d, "i32.div_s"],
		[0x6e, "i32.div_u"],
		[0x6f, "i32.rem_s"],
		[0x70, "i32.rem_u"],
		[0x71, "i32.and"],
		[0x72, "i32.or"],
		[0x73, "i32.xor"],
		[0x74, "i32.shl"],
		[0x75, "i32.shr_s"],
		[0x76, "i32.shr_u"],
		[0x77, "i32.rotl"],
		[0x78, "i32.rotr"],
		[0x79, "i64.clz"],
		[0x7a, "i64.ctz"],
		[0x7b, "i64.popcnt"],
		[0x7c, "i64.add"],
		[0x7d, "i64.sub"],
		[0x7e, "i64.mul"],
		[0x7f, "i64.div_s"],
		[0x80, "i64.div_u"],
		[0x81, "i64.rem_s"],
		[0x82, "i64.rem_u"],
		[0x83, "i64.and"],
		[0x84, "i64.or"],
		[0x85, "i64.xor"],
		[0x86, "i64.shl"],
		[0x87, "i64.shr_s"],
		[0x88, "i64.shr_u"],
		[0x89, "i64.rotl"],
		[0x8a, "i64.rotr"],
		[0x8b, "f32.abs"],
		[0x8c, "f32.neg"],
		[0x8d, "f32.ceil"],
		[0x8e, "f32.floor"],
		[0x8f, "f32.trunc"],
		[0x90, "f32.nearest"],
		[0x91, "f32.sqrt"],
		[0x92, "f32.add"],
		[0x93, "f32.sub"],
		[0x94, "f32.mul"],
		[0x95, "f32.div"],
		[0x96, "f32.min"],
		[0x97, "f32.max"],
		[0x98, "f32.copysign"],
		[0x99, "f64.abs"],
		[0x9a, "f64.neg"],
		[0x9b, "f64.ceil"],
		[0x9c, "f64.floor"],
		[0x9d, "f64.trunc"],
		[0x9e, "f64.nearest"],
		[0x9f, "f64.sqrt"],
		[0xa0, "f64.add"],
		[0xa1, "f64.sub"],
		[0xa2, "f64.mul"],
		[0xa3, "f64.div"],
		[0xa4, "f64.min"],
		[0xa5, "f64.max"],
		[0xa6, "f64.copysign"],
		[0xa7, "i32.wrap_i64"],
		[0xa8, "i32.trunc_f32_s"],
		[0xa9, "i32.trunc_f32_u"],
		[0xaa, "i32.trunc_f64_s"],
		[0xab, "i32.trunc_f64_u"],
		[0xac, "i64.extend_i32_s"],
		[0xad, "i64.extend_i32_u"],
		[0xae, "i64.trunc_f32_s"],
		[0xaf, "i64.trunc_f32_u"],
		[0xb0, "i64.trunc_f64_s"],
		[0xb1, "i64.trunc_f64_u"],
		[0xb2, "f32.convert_i32_s"],
		[0xb3, "f32.convert_i32_u"],
		[0xb4, "f32.convert_i64_s"],
		[0xb5, "f32.convert_i64_u"],
		[0xb6, "f32.demote_f64"],
		[0xb7, "f64.convert_i32_s"],
		[0xb8, "f64.convert_i32_u"],
		[0xb9, "f64.convert_i64_s"],
		[0xba, "f64.convert_i64_u"],
		[0xbb, "f64.promote_f32"],
		[0xbc, "i32.reinterpret_f32"],
		[0xbd, "i64.reinterpret_f64"],
		[0xbe, "f32.reinterpret_i32"],
		[0xbf, "f64.reinterpret_i64"],
	] as const
).map(([opcode, name]) => [[opcode], name]);

/** The loads and stores, each with the alignment 2 and the offset 300, which takes two LEB128 bytes. */
const memoryAccess: readonly Written[] = (
	[
		[0x28, "i32.load"],
		[0x29, "i64.load"],
		[0x2a, "f32.load"],
		[0x2b, "f64.load"],
		[0x2c, "i32.load8_s"],
		[0x2d, "i32.load8_u"],
		[0x2e, "i32.load16_s"],
		[0x2f, "i32.load16_u"],
		[0x30, "i64.load8_s"],
		[0x31, "i64.load8_u"],
		[0x32, "i64.load16_s"],
		[0x33, "i64.load16_u"],
		[0x34, "i64.load32_s"],
		[0x35, "i64.load32_u"],
		[0x36, "i32.store"],
		[0x37, "i64.store"],
		[0x38, "f32.store"],
		[0x39, "f64.store"],
		[0x3a, "i32.store8"],
		[0x3b, "i32.store16"],
		[0x3c, "i64.store8"],
		[0x3d, "i64.store16"],
		[0x3e, "i64.store32"],
	] as const
).map(([opcode, name]) => [[opcode, 0x02, 0xac, 0x02], name, [2, 300]]);

/**
 * Every instruction that the decoder knows, in nested blocks that close
 * before the function's own `end`. The `0x40` byte appears both as the empty
 * block type and as `memory.grow`, which a byte scan can't tell apart.
 */
const everyInstruction: readonly Written[] = [
	[[0x00], "unreachable"],
	[[0x01], "nop"],
	[[0x02, 0x40], "block", [0x40]],
	[[0x03, 0x7f], "loop", [0x7f]],
	[[0x04, 0x7e], "if", [0x7e]],
	[[0x05], "else"],
	[[0x0c, 0x01], "br", [1]],
	[[0x0b], "end"],
	[[0x0d, 0x00], "br_if", [0]],
	[[0x0e, 0x02, 0x00, 0x01, 0x80, 0x01], "br_table", [0, 1, 128]],
	[[0x0b], "end"],
	[[0x0b], "end"],
	[[0x0f], "return"],
	[[0x10, 0x00], "call", [0]],
	[[0x11, 0x00, 0x00], "call_indirect", [0]],
	[[0x1a], "drop"],
	[[0x1b], "select"],
	[[0x20, 0x00], "local.get", [0]],
	[[0x21, 0x81, 0x01], "local.set", [129]],
	[[0x22, 0x00], "local.tee", [0]],
	[[0x23, 0x00], "global.get", [0]],
	[[0x24, 0x00], "global.set", [0]],
	...memoryAccess,
	[[0x3f, 0x00], "memory.size"],
	[[0x40, 0x00], "memory.grow"],
	[[0x41, 0x7f], "i32.const", [-1]],
	[[0x41, 0xc0, 0x00], "i32.const", [64]],
	[[0x42, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f], "i64.const", [-(2n ** 63n)]],
	[[0x43, 0x00, 0x00, 0x80, 0x3f], "f32.const", [0x3f800000]],
	[[0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f], "f64.const", [0x3ff0000000000000n]],
	...numeric,
	[[0xfc, 0x0a, 0x00, 0x00], "memory.copy"],
	[[0xfc, 0x0b, 0x00], "memory.fill"],
	[[0x0b], "end"],
];

const { i32 } = valueType;

/** A module with one function of type `() -> ()`, whose body holds two `i32` locals and then `instructions`. */
function moduleWithBody(instructions: readonly number[], declaredSize?: number): Uint8Array {
	const body = [...vector([[0x02, i32]]), ...instructions];
	return wasmModule(
		section(1, vector([functionType([], [])])),
		section(3, vector([u32(0)])),
		section(10, vector([[...u32(declaredSize ?? body.length), ...body]])),
	);
}

function decodeError(bytes: Uint8Array): string | undefined {
	try {
		decodeFunctionBodies(readModule(bytes));
	} catch (error) {
		if (error instanceof WasmFormatError) {
			return error.message;
		}
		throw error;
	}
	return undefined;
}

// The fixture's body starts after the 8-byte header, the type section, the
// function section, the code section's header, and the body's size and
// locals.
const bodyStart = 8 + 6 + 4 + 3 + 1 + 3;

describe("decodeFunctionBodies", () => {
	test("decodes the fixture into the list of instructions that it was built from", () => {
		const bytes = moduleWithBody(everyInstruction.flatMap(([encoding]) => encoding));
		const [body, ...others] = decodeFunctionBodies(readModule(bytes));
		expect(others).toStrictEqual([]);
		expect(body?.index).toBe(0);
		expect(body?.instructions.map(({ name, immediates }) => [name, immediates])).toStrictEqual(
			everyInstruction.map(([, name, immediates = []]) => [name, immediates]),
		);
	});

	test("gives each instruction its byte offset in the module", () => {
		const [body] = decodeFunctionBodies(
			readModule(moduleWithBody([0x41, ...s32(300), 0x1a, 0x0b])),
		);
		expect(body?.instructions.map(({ offset }) => offset)).toStrictEqual([
			bodyStart,
			bodyStart + 3,
			bodyStart + 4,
		]);
	});

	test("numbers the bodies after the imported functions", () => {
		const bytes = wasmModule(
			section(1, vector([functionType([], [])])),
			section(2, vector([[0x01, 0x65, 0x01, 0x66, 0x00, 0x00]])),
			section(3, vector([u32(0), u32(0)])),
			section(
				10,
				vector([
					[0x02, 0x00, 0x0b],
					[0x02, 0x00, 0x0b],
				]),
			),
		);
		expect(decodeFunctionBodies(readModule(bytes)).map(({ index }) => index)).toStrictEqual([1, 2]);
	});

	test("decodes the committed module, one body per function", () => {
		const module = readModule(readFileSync(join(root, moduleFile)));
		const bodies = decodeFunctionBodies(module);
		expect(bodies).toHaveLength(module.functions.length);
		expect(bodies.every(({ instructions }) => instructions.at(-1)?.name === "end")).toBe(true);
	});

	test("rejects an opcode outside the MVP, bulk memory's copy and fill aside", () => {
		expect(decodeError(moduleWithBody([0x20, 0x00, 0xc0, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 2)}: the opcode 0xc0 is unknown.`,
		);
		expect(decodeError(moduleWithBody([0x1c, 0x01, i32, 0x0b]))).toBe(
			`At byte ${String(bodyStart)}: the opcode 0x1c is unknown.`,
		);
		expect(decodeError(moduleWithBody([0xfc, 0x00, 0x0b]))).toBe(
			`At byte ${String(bodyStart)}: the opcode 0xfc 0 is unknown.`,
		);
		expect(decodeError(moduleWithBody([0xfc, 0x08, 0x00, 0x00, 0x0b]))).toBe(
			`At byte ${String(bodyStart)}: the opcode 0xfc 8 is unknown.`,
		);
		expect(decodeError(moduleWithBody([0xfd, 0x0f, 0x0b]))).toBe(
			`At byte ${String(bodyStart)}: the opcode 0xfd starts a v128 instruction, which the MVP lacks.`,
		);
	});

	test("rejects a block type that only multi-value allows", () => {
		expect(decodeError(moduleWithBody([0x02, 0x00, 0x0b, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 1)}: the block type 0x0 isn't empty or a value type.`,
		);
	});

	test("rejects a reserved byte other than zero", () => {
		expect(decodeError(moduleWithBody([0x3f, 0x01, 0x1a, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 1)}: memory.size has the reserved byte 0x1, not 0x00.`,
		);
		// call-indirect-overlong writes the table index 0 as 0x80 0x00.
		expect(decodeError(moduleWithBody([0x41, 0x00, 0x11, 0x00, 0x80, 0x00, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 4)}: call_indirect has the reserved byte 0x80, not 0x00.`,
		);
		expect(decodeError(moduleWithBody([0xfc, 0x0a, 0x00, 0x01, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 3)}: memory.copy has the reserved byte 0x1, not 0x00.`,
		);
	});

	test("rejects a body whose last end comes before its declared size", () => {
		expect(decodeError(moduleWithBody([0x0b, 0x01, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 1)}: the function body ends before its declared size.`,
		);
	});

	test("rejects a body that reaches its declared size before its last end", () => {
		expect(decodeError(moduleWithBody([0x02, 0x40, 0x0b, 0x01]))).toBe(
			`At byte ${String(bodyStart + 4)}: the bytes end early.`,
		);
		// A declared size one byte short cuts the closing end off.
		expect(decodeError(moduleWithBody([0x01, 0x0b], 4))).toBe(
			`At byte ${String(bodyStart + 1)}: the bytes end early.`,
		);
	});

	test("rejects an else outside an if", () => {
		expect(decodeError(moduleWithBody([0x02, 0x40, 0x05, 0x0b, 0x0b]))).toBe(
			`At byte ${String(bodyStart + 2)}: an else appears outside an if.`,
		);
	});

	test("rejects a code section whose body count differs from the function section", () => {
		const bytes = wasmModule(
			section(1, vector([functionType([], [])])),
			section(3, vector([u32(0), u32(0)])),
			section(10, vector([[0x02, 0x00, 0x0b]])),
		);
		expect(decodeError(bytes)).toBe(
			"The code section holds 1 function bodies, but the function section declares 2.",
		);
	});
});
