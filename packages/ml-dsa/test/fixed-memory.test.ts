import { expect, test } from "vite-plus/test";

import wasmBase64 from "../wasm/mldsa.wasm";
import { layout } from "../src/testing.js";
import { prototypeOf, thrown } from "./helpers.js";

// The package's internal `WebAssembly` declaration leaves out `grow`, which
// no package code may call, so the test declares it.
declare global {
	namespace WebAssembly {
		interface Memory {
			grow(delta: number): number;
		}
	}
}

/** A new instance of the committed module, which no package code holds. */
function newInstanceMemory(): WebAssembly.Memory {
	const binary = atob(wasmBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.memory;
}

test("the module's memory can't grow, and a refused grow leaves its buffer attached", () => {
	const memory = newInstanceMemory();
	const buffer = memory.buffer;
	// oxlint-disable-next-line no-restricted-properties -- the test grows on purpose, on its own instance, to prove that the fixed memory refuses
	const error = thrown(() => memory.grow(1));
	expect(prototypeOf(error)).toBe(RangeError.prototype);
	expect(memory.buffer).toBe(buffer);
	expect(buffer.detached).toBe(false);
	expect(buffer.byteLength).toBe(layout.memoryBytes);
});
