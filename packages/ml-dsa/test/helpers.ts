import { ml_dsa44, ml_dsa65, ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";

import { mlDsa44, mlDsa65, mlDsa87 } from "../src/index.js";
import type { ObjectName } from "../src/parameter-sets.js";
import { currentMemory, freshMemory, layout, type Region } from "../src/testing.js";

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
	return byteSource((index + 1) * 0x9e3779b9)(32);
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

/** The `message` of a thrown error, or `""` if it has none. */
export function messageOf(error: unknown): string {
	const message: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
	return typeof message === "string" ? message : "";
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

/** A view of exactly one region of an instance's memory. */
export function regionOf(memory: Uint8Array<ArrayBuffer>, region: Region): Uint8Array<ArrayBuffer> {
	return memory.subarray(region.pointer, region.pointer + region.length);
}

/**
 * A source of bytes from a seeded xorshift32 sequence, so a list of cases
 * built from one seed is the same on every run.
 */
export function byteSource(seed: number): (length: number) => Uint8Array<ArrayBuffer> {
	// xorshift32 never leaves the all-zero state, so a zero seed starts at 1.
	let state = seed >>> 0 || 1;
	return (length) => {
		const bytes = new Uint8Array(new ArrayBuffer(length));
		for (let offset = 0; offset < length; offset += 1) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			bytes[offset] = state & 0xff;
		}
		return bytes;
	};
}

/** Whether every byte is zero. */
export function isAllZero(bytes: Uint8Array): boolean {
	return bytes.every((byte) => byte === 0);
}

/**
 * Zeroes the wasm stack and every byte from `__heap_base`, as a healthy call's
 * cleanup does, after a test has called a raw export.
 */
export function wipeAfterRawCall(memory: Uint8Array): void {
	memory.fill(0, layout.stack.start, layout.stack.end);
	memory.fill(0, layout.heapBase);
}
