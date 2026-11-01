import { describe, expect, test } from "vite-plus/test";

import {
	freshMemoryMismatch,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
	untypedFunction,
} from "./helpers.js";
import { acceptedForms, badBackings, LengthLiar, watchedReads, wrongTypes } from "./inputs.js";

const backingMessage = (site: string): string =>
	`${site}: seed must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as new Uint8Array(new ArrayBuffer(32)) filled with set.`;

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
			const before = { ...watchedReads };
			for (const [, value] of acceptedForms(seed)) {
				expect(untypedFunction(object, "keygen")(value)).toStrictEqual({ publicKey: expected });
				expect(freshMemoryMismatch()).toBeNull();
			}
			expect(watchedReads).toStrictEqual(before);
		});

		test("throws TypeError for a missing seed", () => {
			expectRejected(undefined, TypeError.prototype, `${site}: seed is required.`);
		});

		test("throws TypeError for each wrong type of seed", () => {
			for (const [, value, type] of wrongTypes(seedFrom(2))) {
				expectRejected(
					value,
					TypeError.prototype,
					`${site}: seed must be a Uint8Array, but typeof seed is "${type}".`,
				);
			}
		});

		test("throws TypeError for a seed on a shared, resizable, or detached buffer", () => {
			for (const [, value] of badBackings(seedFrom(3))) {
				expectRejected(value, TypeError.prototype, backingMessage(site));
			}
		});

		test("throws TypeError for a shared seed before it checks the length", () => {
			const shared = new Uint8Array(new SharedArrayBuffer(31));
			shared.set(seedFrom(3).subarray(0, 31));
			expectRejected(shared, TypeError.prototype, backingMessage(site));
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
