import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";

import { describe, expect, test } from "vite-plus/test";

import {
	freshMemoryMismatch,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
	untypedFunction,
} from "./helpers.js";

const backingMessage = (site: string): string =>
	`${site}: seed must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as new Uint8Array(new ArrayBuffer(32)) filled with set.`;

/** A copy of `bytes` in a `Uint8Array` of another realm. */
function fromAnotherRealm(bytes: Uint8Array): unknown {
	return runInNewContext("(bytes) => new Uint8Array(bytes)")(Array.from(bytes));
}

class Subclass extends Uint8Array {}

// TypeScript declares `length` and `byteOffset` as properties, so a class
// can't override them with accessors, and the tests define the getters here.
class LengthLiar extends Uint8Array {}
Object.defineProperty(LengthLiar.prototype, "length", { get: () => 32 });

class ByteOffsetLiar extends Uint8Array {}
Object.defineProperty(ByteOffsetLiar.prototype, "byteOffset", { get: () => 7 });

for (const { objectName, object, noble } of parameterSetCases) {
	const site = `${objectName}.keygen`;

	/** Expects `keygen(value)` to throw exactly `type` with `message`, and memory to stay fresh. */
	function expectRejected(value: unknown, type: object, message: string): void {
		const error = thrown(() => untypedFunction(object, "keygen")(value));
		expect(prototypeOf(error)).toBe(type);
		expect(error).toHaveProperty("message", message);
		expect(freshMemoryMismatch()).toBeNull();
	}

	describe(site, () => {
		test("derives the public key that noble derives from the same seed", () => {
			const seeds = [
				...Array.from({ length: 16 }, (_, index) => seedFrom(index)),
				new Uint8Array(new ArrayBuffer(32)).fill(0xff),
			];
			for (const seed of seeds) {
				expect(object.keygen(seed).publicKey).toStrictEqual(noble.keygen(seed).publicKey);
				expect(freshMemoryMismatch()).toBeNull();
			}
		});

		test("accepts a seed with a single non-zero byte at each offset", () => {
			for (let offset = 0; offset < 32; offset += 1) {
				const seed = new Uint8Array(new ArrayBuffer(32));
				seed[offset] = 1;
				expect(object.keygen(seed).publicKey).toStrictEqual(noble.keygen(seed).publicKey);
				expect(freshMemoryMismatch()).toBeNull();
			}
		});

		test("returns a new array that owns a fixed-length buffer of its own", () => {
			const seed = seedFrom(0);
			const first = object.keygen(seed).publicKey;
			expect(freshMemoryMismatch()).toBeNull();
			const second = object.keygen(seed).publicKey;
			expect(freshMemoryMismatch()).toBeNull();
			expect(prototypeOf(first)).toBe(Uint8Array.prototype);
			expect(first.byteOffset).toBe(0);
			expect(first.buffer.byteLength).toBe(object.lengths.publicKey);
			expect(first.buffer.resizable).toBe(false);
			expect(first.buffer).not.toBe(second.buffer);
			first.fill(0);
			expect(object.keygen(seed).publicKey).toStrictEqual(second);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("reads exactly the seed's own bytes, whatever its realm, class, or own properties", () => {
			const seed = seedFrom(1);
			const expected = noble.keygen(seed).publicKey;
			const offsetBuffer = new Uint8Array(new ArrayBuffer(64));
			offsetBuffer.set(seed, 16);
			const withOwnLength = new Uint8Array(seed);
			Object.defineProperty(withOwnLength, "length", { value: 31 });
			const withOwnByteOffset = new Uint8Array(seed);
			Object.defineProperty(withOwnByteOffset, "byteOffset", { value: 7 });
			const accepted: readonly unknown[] = [
				Buffer.from(seed),
				new Subclass(seed),
				new LengthLiar(seed),
				new ByteOffsetLiar(seed),
				withOwnLength,
				withOwnByteOffset,
				new Uint8Array(offsetBuffer.buffer, 16, 32),
				fromAnotherRealm(seed),
			];
			for (const value of accepted) {
				expect(untypedFunction(object, "keygen")(value)).toStrictEqual({ publicKey: expected });
				expect(freshMemoryMismatch()).toBeNull();
			}
		});

		test("throws TypeError for a missing seed", () => {
			expectRejected(undefined, TypeError.prototype, `${site}: seed is required.`);
		});

		test.each([
			["null", null, "object"],
			["a number", 32, "number"],
			["a string", "x".repeat(32), "string"],
			["an array of numbers", Array.from(seedFrom(2)), "object"],
			["an ArrayBuffer", new ArrayBuffer(32), "object"],
			["a DataView", new DataView(new ArrayBuffer(32)), "object"],
			["a Uint8ClampedArray", new Uint8ClampedArray(seedFrom(2)), "object"],
			["an Int8Array", new Int8Array(seedFrom(2)), "object"],
			["a Uint16Array", new Uint16Array(16).fill(1), "object"],
			["an array-like object", { length: 32, 0: 1 }, "object"],
			["a Proxy of a Uint8Array", new Proxy(seedFrom(2), {}), "object"],
			["a function", () => seedFrom(2), "function"],
		])("throws TypeError for %s", (_, value, type) => {
			expectRejected(
				value,
				TypeError.prototype,
				`${site}: seed must be a Uint8Array, but typeof seed is "${type}".`,
			);
		});

		test("throws TypeError for a seed on a shared buffer, before it checks the length", () => {
			for (const length of [32, 31]) {
				const shared = new Uint8Array(new SharedArrayBuffer(length));
				shared.set(seedFrom(3).subarray(0, length));
				expectRejected(shared, TypeError.prototype, backingMessage(site));
			}
		});

		test("throws TypeError for a seed on a resizable buffer", () => {
			const resizable = new Uint8Array(new ArrayBuffer(32, { maxByteLength: 64 }));
			resizable.set(seedFrom(3));
			expectRejected(resizable, TypeError.prototype, backingMessage(site));
			const fixedView = new Uint8Array(new ArrayBuffer(32, { maxByteLength: 64 }), 0, 32);
			fixedView.set(seedFrom(3));
			expectRejected(fixedView, TypeError.prototype, backingMessage(site));
		});

		test("throws TypeError for a seed on a detached buffer", () => {
			const seed = seedFrom(3);
			seed.buffer.transfer();
			expectRejected(seed, TypeError.prototype, backingMessage(site));
		});

		test("throws RangeError for a seed that isn't 32 bytes long", () => {
			const lengthMessage = `${site}: seed must be 32 bytes long.`;
			for (const length of [0, 1, 31, 33, 64]) {
				const seed = new Uint8Array(new ArrayBuffer(length)).fill(1);
				expectRejected(seed, RangeError.prototype, lengthMessage);
			}
			const short = new Uint8Array(new ArrayBuffer(31)).fill(1);
			Object.defineProperty(short, "length", { value: 32 });
			expectRejected(short, RangeError.prototype, lengthMessage);
			expectRejected(new LengthLiar(31).fill(1), RangeError.prototype, lengthMessage);
			// The length check comes before the zero check.
			expectRejected(new Uint8Array(new ArrayBuffer(31)), RangeError.prototype, lengthMessage);
		});

		test("throws RangeError for an all-zero seed", () => {
			expectRejected(
				new Uint8Array(new ArrayBuffer(32)),
				RangeError.prototype,
				`${site}: seed must not be all zeros.`,
			);
		});
	});
}
