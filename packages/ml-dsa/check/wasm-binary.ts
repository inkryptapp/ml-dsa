/**
 * Reads the sections of a wasm module that the module checks compare: the
 * types, the imports, the functions, the tables, the memories, the globals,
 * the exports, and the custom sections. It skips the code and data sections
 * by their declared sizes, so it doesn't decode a single instruction of a
 * function body.
 *
 * The reader accepts the MVP binary format, the data count section of bulk
 * memory, and the shared flag of memory limits. The export list records that
 * flag. Anything else, such as a section out of order, an unknown section or
 * type, a section that doesn't end at its declared size, or a LEB128 number
 * that runs past 32 bits, throws a {@link WasmFormatError} that names the
 * byte offset.
 */

/** A value type, as the text format names it. */
export type ValueType = "i32" | "i64" | "f32" | "f64";

/** A function's parameter and result types. */
export interface FunctionType {
	readonly params: readonly ValueType[];
	readonly results: readonly ValueType[];
}

/** The limits of a memory or a table, in pages or elements. */
export interface Limits {
	readonly min: number;
	/** The maximum, or `undefined` when the limits have none. */
	readonly max: number | undefined;
	readonly shared: boolean;
}

/** The value type and the mutability of a global. */
export interface GlobalType {
	readonly valueType: ValueType;
	readonly mutable: boolean;
}

/** A global of the module, defined or imported. */
export interface Global {
	readonly type: GlobalType;
	/**
	 * The value of an initializer that is one `i32.const`, or `undefined` for
	 * any other initializer and for an imported global, which has none.
	 */
	readonly i32Value: number | undefined;
}

/** What an import or an export names. */
export type ExternalKind = "func" | "table" | "memory" | "global";

/** An import, with the type of what it imports. */
export type Import = {
	readonly module: string;
	readonly name: string;
} & (
	| { readonly kind: "func"; readonly typeIndex: number }
	| { readonly kind: "table"; readonly limits: Limits }
	| { readonly kind: "memory"; readonly limits: Limits }
	| { readonly kind: "global"; readonly type: GlobalType }
);

/** An export, with its index in the index space of its kind. */
export interface Export {
	readonly name: string;
	readonly kind: ExternalKind;
	readonly index: number;
}

/** A custom section's name and contents. */
export interface CustomSection {
	readonly name: string;
	readonly bytes: Uint8Array;
}

/** The sections of a module that {@link readModule} decodes. */
export interface WasmModule {
	readonly types: readonly FunctionType[];
	readonly imports: readonly Import[];
	/** The type index of each function that the module defines, after the imported ones. */
	readonly functions: readonly number[];
	/** The limits of each table that the module defines, whose elements are all `funcref`. */
	readonly tables: readonly Limits[];
	readonly memories: readonly Limits[];
	/** The globals that the module defines, after the imported ones. */
	readonly globals: readonly Global[];
	readonly exports: readonly Export[];
	readonly customSections: readonly CustomSection[];
}

/** The bytes don't follow the part of the wasm binary format that the reader accepts. */
export class WasmFormatError extends Error {}

const valueTypes: ReadonlyMap<number, ValueType> = new Map([
	[0x7f, "i32"],
	[0x7e, "i64"],
	[0x7d, "f32"],
	[0x7c, "f64"],
]);

const externalKinds: readonly ExternalKind[] = ["func", "table", "memory", "global"];

/**
 * The order of the known non-custom sections, by section id. Each may appear
 * at most once, and only after every section that comes before it here.
 */
const sectionOrder: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11];

// A wasm name keeps a leading U+FEFF, which the decoder drops by default.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A cursor over the module's bytes, which throws instead of reading past `end`. */
class Reader {
	offset: number;
	readonly #bytes: Uint8Array;
	readonly #end: number;

	constructor(bytes: Uint8Array, offset: number, end: number) {
		this.#bytes = bytes;
		this.offset = offset;
		this.#end = end;
	}

	fail(what: string, at: number = this.offset): never {
		throw new WasmFormatError(`At byte ${String(at)}: ${what}`);
	}

	atEnd(): boolean {
		return this.offset >= this.#end;
	}

	byte(): number {
		const value = this.#bytes[this.offset];
		if (value === undefined || this.offset >= this.#end) {
			return this.fail("the bytes end early.");
		}
		this.offset += 1;
		return value;
	}

	bytes(length: number): Uint8Array {
		if (length > this.#end - this.offset) {
			return this.fail(`${String(length)} bytes run past the end.`);
		}
		const start = this.offset;
		this.offset += length;
		return this.#bytes.subarray(start, this.offset);
	}

	/** An unsigned LEB128 number of at most 32 bits, in at most 5 bytes. */
	u32(): number {
		const start = this.offset;
		let value = 0;
		for (let shift = 0; shift < 35; shift += 7) {
			const byte = this.byte();
			if (shift === 28 && byte > 0x0f) {
				return this.fail("an unsigned LEB128 number runs past 32 bits.", start);
			}
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) {
				return value;
			}
		}
		return this.fail("an unsigned LEB128 number runs past 32 bits.", start);
	}

	/**
	 * A signed LEB128 number of at most 64 bits, skipped without its value. The
	 * 10th byte carries the last value bit, so it must be 0x00 or 0x7f.
	 */
	skipS64(): void {
		const start = this.offset;
		for (let count = 1; count <= 10; count += 1) {
			const byte = this.byte();
			if (count === 10 && byte !== 0x00 && byte !== 0x7f) {
				break;
			}
			if ((byte & 0x80) === 0) {
				return;
			}
		}
		this.fail("a signed LEB128 number runs past 64 bits.", start);
	}

	/** A signed LEB128 number of at most 32 bits, in at most 5 bytes. */
	s32(): number {
		const start = this.offset;
		let value = 0;
		for (let shift = 0; shift < 35; shift += 7) {
			const byte = this.byte();
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) {
				const signed = (byte & 0x40) === 0 ? value : value - 2 ** (shift + 7);
				if (signed < -(2 ** 31) || signed >= 2 ** 31) {
					return this.fail("a signed LEB128 number runs past 32 bits.", start);
				}
				return signed;
			}
		}
		return this.fail("a signed LEB128 number runs past 32 bits.", start);
	}

	name(): string {
		const start = this.offset;
		const bytes = this.bytes(this.u32());
		try {
			return utf8.decode(bytes);
		} catch {
			return this.fail("a name isn't valid UTF-8.", start);
		}
	}

	vector<Item>(readItem: () => Item): Item[] {
		const count = this.u32();
		const items: Item[] = [];
		for (let index = 0; index < count; index += 1) {
			items.push(readItem());
		}
		return items;
	}

	valueType(): ValueType {
		const start = this.offset;
		const code = this.byte();
		return (
			valueTypes.get(code) ?? this.fail(`the value type 0x${code.toString(16)} is unknown.`, start)
		);
	}

	functionType(): FunctionType {
		const start = this.offset;
		const form = this.byte();
		if (form !== 0x60) {
			return this.fail(`the type form 0x${form.toString(16)} isn't a function type.`, start);
		}
		const params = this.vector(() => this.valueType());
		const resultsStart = this.offset;
		const results = this.vector(() => this.valueType());
		if (results.length > 1) {
			return this.fail(
				"a function type has more than one result, which the MVP forbids.",
				resultsStart,
			);
		}
		return { params, results };
	}

	limits(allowShared: boolean): Limits {
		const start = this.offset;
		const flags = this.byte();
		if (flags > (allowShared ? 0x03 : 0x01)) {
			return this.fail(`the limits flags 0x${flags.toString(16)} are unknown.`, start);
		}
		const min = this.u32();
		const max = (flags & 0x01) === 0 ? undefined : this.u32();
		return { min, max, shared: (flags & 0x02) !== 0 };
	}

	/** Reads a table type, whose element type must be `funcref` as in the MVP, and returns its limits. */
	tableType(): Limits {
		const start = this.offset;
		const elementType = this.byte();
		if (elementType !== 0x70) {
			return this.fail(
				`the table element type 0x${elementType.toString(16)} isn't funcref.`,
				start,
			);
		}
		return this.limits(false);
	}

	globalType(): GlobalType {
		const valueType = this.valueType();
		const start = this.offset;
		const mutability = this.byte();
		if (mutability > 0x01) {
			return this.fail(`the mutability 0x${mutability.toString(16)} is unknown.`, start);
		}
		return { valueType, mutable: mutability === 0x01 };
	}

	/**
	 * An MVP constant expression, up to and including its `end`. Returns the
	 * value when the expression is one `i32.const`.
	 */
	constantExpression(): number | undefined {
		let instructions = 0;
		let i32Value: number | undefined = undefined;
		for (;;) {
			const start = this.offset;
			const opcode = this.byte();
			if (opcode === 0x0b) {
				return instructions === 1 ? i32Value : undefined;
			}
			instructions += 1;
			if (opcode === 0x41) {
				i32Value = this.s32();
			} else if (opcode === 0x42) {
				this.skipS64();
			} else if (opcode === 0x43) {
				this.bytes(4);
			} else if (opcode === 0x44) {
				this.bytes(8);
			} else if (opcode === 0x23) {
				this.u32();
			} else {
				return this.fail(
					`the opcode 0x${opcode.toString(16)} can't appear in a constant expression.`,
					start,
				);
			}
		}
	}
}

/** Reads one entry of the import section. */
function readImport(reader: Reader): Import {
	const module = reader.name();
	const name = reader.name();
	const start = reader.offset;
	const kind = externalKinds[reader.byte()] ?? reader.fail("an import's kind is unknown.", start);
	switch (kind) {
		case "func":
			return { module, name, kind, typeIndex: reader.u32() };
		case "table":
			return { module, name, kind, limits: reader.tableType() };
		case "memory":
			return { module, name, kind, limits: reader.limits(true) };
		case "global":
			return { module, name, kind, type: reader.globalType() };
	}
}

function readExport(reader: Reader): Export {
	const name = reader.name();
	const start = reader.offset;
	const kind = externalKinds[reader.byte()] ?? reader.fail("an export's kind is unknown.", start);
	return { name, kind, index: reader.u32() };
}

/**
 * Reads the sections of a wasm module. Throws a {@link WasmFormatError} if
 * the bytes break the binary format as the module comment above describes.
 */
export function readModule(bytes: Uint8Array): WasmModule {
	const reader = new Reader(bytes, 0, bytes.length);
	const preamble = reader.bytes(Math.min(8, bytes.length));
	const expected = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
	if (preamble.length !== 8 || !expected.every((byte, index) => preamble[index] === byte)) {
		return reader.fail("the module doesn't start with the wasm magic number and version 1.", 0);
	}

	let types: FunctionType[] = [];
	let imports: Import[] = [];
	let functions: number[] = [];
	let tables: Limits[] = [];
	let memories: Limits[] = [];
	let globals: Global[] = [];
	let exports: Export[] = [];
	const customSections: CustomSection[] = [];
	let lastRank = -1;

	while (!reader.atEnd()) {
		const start = reader.offset;
		const id = reader.byte();
		const size = reader.u32();
		const contents = reader.bytes(size);
		const end = reader.offset;
		const section = new Reader(bytes, end - size, end);
		if (id === 0) {
			const name = section.name();
			customSections.push({ name, bytes: section.bytes(end - section.offset) });
			continue;
		}
		const rank = sectionOrder.indexOf(id);
		if (rank === -1) {
			return reader.fail(`the section id ${String(id)} is unknown.`, start);
		}
		if (rank <= lastRank) {
			return reader.fail(`the section id ${String(id)} is out of order or repeated.`, start);
		}
		lastRank = rank;
		switch (id) {
			case 1:
				types = section.vector(() => section.functionType());
				break;
			case 2:
				imports = section.vector(() => readImport(section));
				break;
			case 3:
				functions = section.vector(() => section.u32());
				break;
			case 4:
				tables = section.vector(() => section.tableType());
				break;
			case 5:
				memories = section.vector(() => section.limits(true));
				break;
			case 6:
				globals = section.vector(() => {
					const type = section.globalType();
					return { type, i32Value: section.constantExpression() };
				});
				break;
			case 7:
				exports = section.vector(() => readExport(section));
				break;
			default:
				section.offset = end;
		}
		if (section.offset !== end) {
			return reader.fail(
				`the section id ${String(id)} declares ${String(contents.length)} bytes, but its contents end at byte ${String(section.offset)}.`,
				start,
			);
		}
	}
	return { types, imports, functions, tables, memories, globals, exports, customSections };
}

/** One tool or language that a `producers` section names, with its version. */
export interface Producer {
	readonly name: string;
	readonly version: string;
}

/** The fields of a `producers` section, each with the tools that it names. */
export type ProducerFields = ReadonlyMap<string, readonly Producer[]>;

/**
 * Reads the contents of a `producers` custom section: each field, such as
 * `processed-by`, with the tools that it names, in section order.
 */
export function readProducers(bytes: Uint8Array): ProducerFields {
	const reader = new Reader(bytes, 0, bytes.length);
	const fields = new Map<string, readonly Producer[]>();
	for (const [field, producers] of reader.vector(
		() =>
			[
				reader.name(),
				reader.vector(() => ({ name: reader.name(), version: reader.name() })),
			] as const,
	)) {
		if (fields.has(field)) {
			return reader.fail(`the producers section names the field "${field}" twice.`);
		}
		fields.set(field, producers);
	}
	if (!reader.atEnd()) {
		return reader.fail("the producers section has bytes after its last field.");
	}
	return fields;
}

/** Reads every `producers` section of a module, in module order. */
export function producerSections(module: WasmModule): readonly ProducerFields[] {
	return module.customSections
		.filter((section) => section.name === "producers")
		.map((section) => readProducers(section.bytes));
}
