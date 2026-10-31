// Each line marked `// lint: <member>` reaches a member that detaches the wasm
// memory's buffer. The lint test expects one no-restricted-properties error on
// each marked line, and no other error.

// `grow` is a function property, not a method, so destructuring it on its
// marked line doesn't also break `unbound-method`.
interface DetachingMemory {
	readonly grow: (delta: number) => number;
	toResizableBuffer(): ArrayBuffer;
	toFixedLengthBuffer(): ArrayBuffer;
}

export function reach(memory: DetachingMemory, maybeMemory: DetachingMemory | undefined): void {
	memory.grow(0); // lint: grow
	memory["grow"](0); // lint: grow
	maybeMemory?.grow(0); // lint: grow
	const { grow } = memory; // lint: grow
	void grow;
	memory.toResizableBuffer(); // lint: toResizableBuffer
	memory.toFixedLengthBuffer(); // lint: toFixedLengthBuffer
}
