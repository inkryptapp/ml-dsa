/** An address in the wasm module's linear memory, kept apart from lengths and return codes. */
export type Pointer = number & { readonly __brand: "Pointer" };

/** Brands a byte offset into the wasm module's linear memory as a {@link Pointer}. */
export function pointer(offset: number): Pointer {
	return offset as Pointer;
}

/** The C null pointer, for an argument that upstream ignores or allows to be `NULL`. */
export const nullPointer: Pointer = pointer(0);
