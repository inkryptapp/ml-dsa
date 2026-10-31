import { ml_dsa44, ml_dsa65, ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";

import { mlDsa44, mlDsa65, mlDsa87 } from "../src/index.js";
import type { ObjectName } from "../src/parameter-sets.js";
import { currentMemory, freshMemory } from "../src/testing.js";

/** An exported object with its name and the noble 0.7.1 object for the same parameter set. */
export interface ParameterSetCase {
	readonly objectName: ObjectName;
	readonly object: typeof mlDsa44 | typeof mlDsa65 | typeof mlDsa87;
	readonly noble: typeof ml_dsa44;
}

/** Every parameter set, in order. */
export const parameterSetCases: readonly ParameterSetCase[] = [
	{ objectName: "mlDsa44", object: mlDsa44, noble: ml_dsa44 },
	{ objectName: "mlDsa65", object: mlDsa65, noble: ml_dsa65 },
	{ objectName: "mlDsa87", object: mlDsa87, noble: ml_dsa87 },
];

/**
 * A 32-byte seed from a fixed xorshift sequence, so every run uses the same
 * seeds. It sits on an `ArrayBuffer` of its own.
 */
export function seedFrom(index: number): Uint8Array<ArrayBuffer> {
	const seed = new Uint8Array(new ArrayBuffer(32));
	let state = (index + 1) * 0x9e3779b9;
	for (let offset = 0; offset < seed.length; offset += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		seed[offset] = state & 0xff;
	}
	return seed;
}

/**
 * `target[key]` typed as a function of one `unknown` argument, so a test can
 * pass a value that the public type rejects.
 */
export function untypedFunction(target: object, key: string): (argument: unknown) => unknown {
	return Reflect.get(target, key);
}

/** Runs `action` and returns what it threw. Fails if it returned instead. */
export function thrown(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("The action returned instead of throwing.");
}

/** The prototype of a thrown value, which tells `TypeError`, `RangeError`, and a plain `Error` apart. */
export function prototypeOf(value: unknown): object | null {
	return typeof value === "object" && value !== null ? Reflect.getPrototypeOf(value) : null;
}

/** The offset of the first byte where `memory` differs from `expected`, or `null` if they are equal. */
export function firstDifference(
	memory: Readonly<Uint8Array>,
	expected: Readonly<Uint8Array>,
): number | null {
	if (memory.length !== expected.length) {
		return Math.min(memory.length, expected.length);
	}
	for (let offset = 0; offset < memory.length; offset += 1) {
		if (memory[offset] !== expected[offset]) {
			return offset;
		}
	}
	return null;
}

/**
 * Where the memory of the instance in the slot differs from a fresh instance's
 * memory: `null` if it equals it byte for byte, `"no instance"` if the slot is
 * empty, or the first differing offset.
 */
export function freshMemoryMismatch(): number | "no instance" | null {
	const memory = currentMemory();
	return memory === null ? "no instance" : firstDifference(memory, freshMemory);
}
