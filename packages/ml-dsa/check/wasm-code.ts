/**
 * Decodes each function body of a module's code section into its
 * instructions. The decoder knows the MVP opcodes, plus `memory.copy` and
 * `memory.fill` from bulk memory. It throws a {@link WasmFormatError} that
 * names the byte offset on an unknown opcode, on a block type or a reserved
 * byte that the MVP doesn't allow, on an `else` outside an `if`, and on a
 * body that doesn't end exactly at its declared size.
 *
 * A byte scan can't count instructions, because an opcode byte can also be
 * an immediate. For example, `0x40` is `memory.grow` and also the empty
 * block type.
 */
import { Reader, WasmFormatError, type WasmModule } from "./wasm-binary.ts";

/** One decoded instruction. */
export interface Instruction {
	/** The instruction's name in the text format, such as `i64.load`. */
	readonly name: string;
	/**
	 * The immediates in binary order. A block type is its byte, such as `0x40`
	 * for the empty type. A load or store gives its alignment and offset, a
	 * `br_table` its labels and then its default label, and a float constant
	 * its bits. An `i64.const` gives a `bigint`, as does an `f64.const`. A
	 * reserved byte, which must be zero, isn't an immediate.
	 */
	readonly immediates: readonly (number | bigint)[];
	/** The offset of the opcode's first byte in the module. */
	readonly offset: number;
}

/** The instructions of one function body, its closing `end` included. */
export interface FunctionBody {
	/** The function's index, which counts the imported functions first. */
	readonly index: number;
	readonly instructions: readonly Instruction[];
}

type Immediates =
	| "none"
	| "block type"
	| "index"
	| "branch table"
	| "call_indirect"
	| "memory access"
	| "reserved"
	| "i32"
	| "i64"
	| "f32"
	| "f64";

interface Opcode {
	readonly name: string;
	readonly immediates: Immediates;
}

const control: readonly (readonly [number, string, Immediates])[] = [
	[0x00, "unreachable", "none"],
	[0x01, "nop", "none"],
	[0x02, "block", "block type"],
	[0x03, "loop", "block type"],
	[0x04, "if", "block type"],
	[0x05, "else", "none"],
	[0x0b, "end", "none"],
	[0x0c, "br", "index"],
	[0x0d, "br_if", "index"],
	[0x0e, "br_table", "branch table"],
	[0x0f, "return", "none"],
	[0x10, "call", "index"],
	[0x11, "call_indirect", "call_indirect"],
	[0x1a, "drop", "none"],
	[0x1b, "select", "none"],
	[0x20, "local.get", "index"],
	[0x21, "local.set", "index"],
	[0x22, "local.tee", "index"],
	[0x23, "global.get", "index"],
	[0x24, "global.set", "index"],
	[0x3f, "memory.size", "reserved"],
	[0x40, "memory.grow", "reserved"],
	[0x41, "i32.const", "i32"],
	[0x42, "i64.const", "i64"],
	[0x43, "f32.const", "f32"],
	[0x44, "f64.const", "f64"],
];

/** The loads and stores, from 0x28 to 0x3e. */
const memoryAccess: readonly string[] = [
	"i32.load",
	"i64.load",
	"f32.load",
	"f64.load",
	"i32.load8_s",
	"i32.load8_u",
	"i32.load16_s",
	"i32.load16_u",
	"i64.load8_s",
	"i64.load8_u",
	"i64.load16_s",
	"i64.load16_u",
	"i64.load32_s",
	"i64.load32_u",
	"i32.store",
	"i64.store",
	"f32.store",
	"f64.store",
	"i32.store8",
	"i32.store16",
	"i64.store8",
	"i64.store16",
	"i64.store32",
];

const integerOperations = (type: "i32" | "i64"): readonly string[] =>
	[
		"clz",
		"ctz",
		"popcnt",
		"add",
		"sub",
		"mul",
		"div_s",
		"div_u",
		"rem_s",
		"rem_u",
		"and",
		"or",
		"xor",
		"shl",
		"shr_s",
		"shr_u",
		"rotl",
		"rotr",
	].map((operation) => `${type}.${operation}`);

const floatOperations = (type: "f32" | "f64"): readonly string[] =>
	[
		"abs",
		"neg",
		"ceil",
		"floor",
		"trunc",
		"nearest",
		"sqrt",
		"add",
		"sub",
		"mul",
		"div",
		"min",
		"max",
		"copysign",
	].map((operation) => `${type}.${operation}`);

const integerComparisons = (type: "i32" | "i64"): readonly string[] =>
	["eqz", "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"].map(
		(comparison) => `${type}.${comparison}`,
	);

const floatComparisons = (type: "f32" | "f64"): readonly string[] =>
	["eq", "ne", "lt", "gt", "le", "ge"].map((comparison) => `${type}.${comparison}`);

/** The instructions without immediates, from 0x45 to 0xbf. */
const numeric: readonly string[] = [
	...integerComparisons("i32"),
	...integerComparisons("i64"),
	...floatComparisons("f32"),
	...floatComparisons("f64"),
	...integerOperations("i32"),
	...integerOperations("i64"),
	...floatOperations("f32"),
	...floatOperations("f64"),
	"i32.wrap_i64",
	"i32.trunc_f32_s",
	"i32.trunc_f32_u",
	"i32.trunc_f64_s",
	"i32.trunc_f64_u",
	"i64.extend_i32_s",
	"i64.extend_i32_u",
	"i64.trunc_f32_s",
	"i64.trunc_f32_u",
	"i64.trunc_f64_s",
	"i64.trunc_f64_u",
	"f32.convert_i32_s",
	"f32.convert_i32_u",
	"f32.convert_i64_s",
	"f32.convert_i64_u",
	"f32.demote_f64",
	"f64.convert_i32_s",
	"f64.convert_i32_u",
	"f64.convert_i64_s",
	"f64.convert_i64_u",
	"f64.promote_f32",
	"i32.reinterpret_f32",
	"i64.reinterpret_f64",
	"f32.reinterpret_i32",
	"f64.reinterpret_i64",
];

/** The opcodes of one byte, keyed by that byte. */
const opcodes: ReadonlyMap<number, Opcode> = new Map([
	...control.map(([code, name, immediates]) => [code, { name, immediates }] as const),
	...memoryAccess.map(
		(name, index) => [0x28 + index, { name, immediates: "memory access" }] as const,
	),
	...numeric.map((name, index) => [0x45 + index, { name, immediates: "none" }] as const),
]);

/** The two bulk-memory opcodes after the 0xfc prefix, keyed by their subopcode. */
const bulkMemory: ReadonlyMap<number, { readonly name: string; readonly reservedBytes: number }> =
	new Map([
		[10, { name: "memory.copy", reservedBytes: 2 }],
		[11, { name: "memory.fill", reservedBytes: 1 }],
	]);

const blockTypes = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c]);

function reservedByte(reader: Reader, name: string): void {
	const start = reader.offset;
	const byte = reader.byte();
	if (byte !== 0x00) {
		reader.fail(`${name} has the reserved byte 0x${byte.toString(16)}, not 0x00.`, start);
	}
}

/** A signed LEB128 number of at most 64 bits, in at most 10 bytes. */
function s64(reader: Reader): bigint {
	const start = reader.offset;
	let value = 0n;
	for (let shift = 0n; shift < 70n; shift += 7n) {
		const byte = reader.byte();
		value |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			const signed = (byte & 0x40) === 0 ? value : value - (1n << (shift + 7n));
			if (signed >= -(2n ** 63n) && signed < 2n ** 63n) {
				return signed;
			}
			break;
		}
	}
	return reader.fail("a signed LEB128 number runs past 64 bits.", start);
}

function littleEndian(bytes: Uint8Array): bigint {
	return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function readImmediates(reader: Reader, opcode: Opcode): readonly (number | bigint)[] {
	switch (opcode.immediates) {
		case "none":
			return [];
		case "block type": {
			const start = reader.offset;
			const type = reader.byte();
			if (!blockTypes.has(type)) {
				return reader.fail(
					`the block type 0x${type.toString(16)} isn't empty or a value type.`,
					start,
				);
			}
			return [type];
		}
		case "index":
			return [reader.u32()];
		case "branch table":
			return [...reader.vector(() => reader.u32()), reader.u32()];
		case "call_indirect": {
			const typeIndex = reader.u32();
			reservedByte(reader, opcode.name);
			return [typeIndex];
		}
		case "memory access":
			return [reader.u32(), reader.u32()];
		case "reserved":
			reservedByte(reader, opcode.name);
			return [];
		case "i32":
			return [reader.s32()];
		case "i64":
			return [s64(reader)];
		case "f32":
			return [Number(littleEndian(reader.bytes(4)))];
		case "f64":
			return [littleEndian(reader.bytes(8))];
	}
}

/** Reads the instruction at the reader's offset. `base` is the module offset of the reader's bytes. */
function readInstruction(reader: Reader, base: number): Instruction {
	const start = reader.offset;
	const code = reader.byte();
	if (code === 0xfc) {
		const subopcode = reader.u32();
		const bulk = bulkMemory.get(subopcode);
		if (bulk === undefined) {
			return reader.fail(`the opcode 0xfc ${String(subopcode)} is unknown.`, start);
		}
		for (let count = 0; count < bulk.reservedBytes; count += 1) {
			reservedByte(reader, bulk.name);
		}
		return { name: bulk.name, immediates: [], offset: start + base };
	}
	if (code === 0xfd) {
		return reader.fail("the opcode 0xfd starts a v128 instruction, which the MVP lacks.", start);
	}
	const opcode =
		opcodes.get(code) ?? reader.fail(`the opcode 0x${code.toString(16)} is unknown.`, start);
	return { name: opcode.name, immediates: readImmediates(reader, opcode), offset: start + base };
}

/**
 * Decodes one body, from its locals to the `end` that closes the function,
 * which must be the body's last byte. Each `block`, `loop`, and `if` opens a
 * level that an `end` closes.
 */
function readBody(reader: Reader, base: number): readonly Instruction[] {
	reader.vector(() => [reader.u32(), reader.valueType()]);
	const instructions: Instruction[] = [];
	const open: string[] = [];
	for (;;) {
		const instruction = readInstruction(reader, base);
		instructions.push(instruction);
		switch (instruction.name) {
			case "block":
			case "loop":
			case "if":
				open.push(instruction.name);
				break;
			case "else":
				if (open.at(-1) !== "if") {
					reader.fail("an else appears outside an if.", instruction.offset - base);
				}
				break;
			case "end":
				if (open.pop() === undefined) {
					if (!reader.atEnd()) {
						reader.fail("the function body ends before its declared size.");
					}
					return instructions;
				}
				break;
			default:
		}
	}
}

/**
 * Decodes every function body of the module's code section. Throws a
 * {@link WasmFormatError} if a body breaks the rules in the module comment
 * above, or if the code section's body count differs from the function
 * section's.
 */
export function decodeFunctionBodies(module: WasmModule): readonly FunctionBody[] {
	const imported = module.imports.filter((entry) => entry.kind === "func").length;
	const code = module.code;
	if (code === undefined) {
		if (module.functions.length > 0) {
			throw new WasmFormatError(
				`The module declares ${String(module.functions.length)} functions but has no code section.`,
			);
		}
		return [];
	}
	const reader = new Reader(code.bytes, 0, code.bytes.length, code.offset);
	const bodies = reader.vector(() => {
		const size = reader.u32();
		const start = reader.offset;
		const body = new Reader(code.bytes, start, start + size, code.offset);
		reader.bytes(size);
		return readBody(body, code.offset);
	});
	if (!reader.atEnd()) {
		reader.fail("the code section has bytes after its last function body.");
	}
	if (bodies.length !== module.functions.length) {
		throw new WasmFormatError(
			`The code section holds ${String(bodies.length)} function bodies, but the function section declares ${String(module.functions.length)}.`,
		);
	}
	return bodies.map((instructions, index) => ({ index: imported + index, instructions }));
}
