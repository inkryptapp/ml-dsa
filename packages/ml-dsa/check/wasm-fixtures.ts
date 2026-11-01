/**
 * Builds small wasm modules byte by byte, so a test can give a reader exactly
 * the section that it means to test. The path scan also builds its negative
 * fixture with these.
 */

/** An unsigned LEB128 number. */
export function u32(value: number): number[] {
	const bytes: number[] = [];
	let rest = value;
	do {
		const low = rest % 128;
		rest = Math.floor(rest / 128);
		bytes.push(rest === 0 ? low : low | 0x80);
	} while (rest !== 0);
	return bytes;
}

/** A signed LEB128 number. */
export function s32(value: number): number[] {
	const bytes: number[] = [];
	let rest = value;
	for (;;) {
		const low = ((rest % 128) + 128) % 128;
		rest = Math.floor(rest / 128);
		const done = (rest === 0 && (low & 0x40) === 0) || (rest === -1 && (low & 0x40) !== 0);
		bytes.push(done ? low : low | 0x80);
		if (done) {
			return bytes;
		}
	}
}

/** A name: its UTF-8 length, then its bytes. */
export function name(text: string): number[] {
	const bytes = [...new TextEncoder().encode(text)];
	return [...u32(bytes.length), ...bytes];
}

/** A vector: its item count, then its items. */
export function vector(items: readonly (readonly number[])[]): number[] {
	return [...u32(items.length), ...items.flat()];
}

/** A section: its id, its size, then its contents. */
export function section(id: number, contents: readonly number[]): number[] {
	return [id, ...u32(contents.length), ...contents];
}

/** A custom section with `name` and `contents`. */
export function customSection(sectionName: string, contents: readonly number[]): number[] {
	return section(0, [...name(sectionName), ...contents]);
}

/** A module: the magic number and version 1, then `sections` in order. */
export function wasmModule(...sections: readonly (readonly number[])[]): Uint8Array<ArrayBuffer> {
	return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

/** The binary codes of the value types that the fixtures use. */
export const valueType = { i32: 0x7f, i64: 0x7e, funcref: 0x70 } as const;

/** A function type with `params` and `results`. */
export function functionType(params: readonly number[], results: readonly number[]): number[] {
	return [0x60, ...vector(params.map((type) => [type])), ...vector(results.map((type) => [type]))];
}

/** A `producers` section with the given fields, each with its tools and their versions. */
export function producersSection(
	fields: readonly (readonly [string, readonly (readonly [string, string])[]])[],
): number[] {
	return customSection(
		"producers",
		vector(
			fields.map(([field, tools]) => [
				...name(field),
				...vector(tools.map(([tool, version]) => [...name(tool), ...name(version)])),
			]),
		),
	);
}

/** A `name` section with the given subsections, each an id and its contents. */
export function nameSection(
	...subsections: readonly (readonly [number, readonly number[]])[]
): number[] {
	return customSection(
		"name",
		subsections.flatMap(([id, contents]) => [id, ...u32(contents.length), ...contents]),
	);
}

/** A `name` section that names each function `index` as `names[index]`. */
export function functionNameSection(names: readonly string[]): number[] {
	return nameSection([1, vector(names.map((text, index) => [...u32(index), ...name(text)]))]);
}
