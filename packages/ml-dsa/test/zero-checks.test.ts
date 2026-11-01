import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import { freshMemoryMismatch, prototypeOf, seedFrom, thrown } from "./helpers.js";

// The zero checks OR all 32 bytes, so every input with a single set bit must
// pass them. A check that skipped a byte or a bit would refuse one of these.

/** A 32-byte input whose only set bit is `bit` of byte `offset`. */
function singleBit(offset: number, bit: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(32));
	bytes[offset] = 1 << bit;
	return bytes;
}

/** Every single-bit input, with whether it is a diagonal case: bit `offset % 8` of byte `offset`. */
const singleBitInputs = Array.from({ length: 256 }, (_, index) => {
	const offset = Math.floor(index / 8);
	const bit = index % 8;
	return { input: singleBit(offset, bit), diagonal: bit === offset % 8 };
});

const seed = seedFrom(60);
const randomness = seedFrom(61);
const message = new Uint8Array([1, 2, 3, 4]);
const { secretKey } = ml_dsa44.keygen(seed);

/**
 * One checked input: how a call passes it, the length of the call's output,
 * and noble's output for the same input.
 */
interface CheckedInput {
	readonly name: string;
	readonly call: (input: Uint8Array<ArrayBuffer>) => Uint8Array;
	readonly outputLength: number;
	readonly reference: (input: Uint8Array<ArrayBuffer>) => Uint8Array;
}

const checkedInputs: readonly CheckedInput[] = [
	{
		name: "the seed through keygen",
		call: (input) => mlDsa44.keygen(input).publicKey,
		outputLength: mlDsa44.lengths.publicKey,
		reference: (input) => ml_dsa44.keygen(input).publicKey,
	},
	{
		name: "the seed through sign",
		call: (input) => mlDsa44.sign({ seed: input, message, randomness }),
		outputLength: mlDsa44.lengths.signature,
		reference: (input) =>
			ml_dsa44.sign(message, ml_dsa44.keygen(input).secretKey, { extraEntropy: randomness }),
	},
	{
		name: "the randomness through sign",
		call: (input) => mlDsa44.sign({ seed, message, randomness: input }),
		outputLength: mlDsa44.lengths.signature,
		reference: (input) => ml_dsa44.sign(message, secretKey, { extraEntropy: input }),
	},
];

describe("the zero checks", () => {
	test("accept the 32 diagonal cases of each input, which match noble", () => {
		let comparisons = 0;
		for (const { call, reference } of checkedInputs) {
			for (const { input } of singleBitInputs.filter(({ diagonal }) => diagonal)) {
				expect(call(input)).toStrictEqual(reference(input));
				comparisons += 1;
			}
			expect(freshMemoryMismatch()).toBeNull();
		}
		expect(comparisons).toBe(96);
	});

	test("accept every single-bit input", () => {
		let calls = 0;
		for (const { call, outputLength } of checkedInputs) {
			for (const { input } of singleBitInputs) {
				expect(call(input)).toHaveLength(outputLength);
				calls += 1;
			}
			expect(freshMemoryMismatch()).toBeNull();
		}
		expect(calls).toBe(768);
	});

	test.each(checkedInputs)("refuse 32 zero bytes as $name", ({ call }) => {
		const error = thrown(() => call(new Uint8Array(new ArrayBuffer(32))));
		expect(prototypeOf(error)).toBe(RangeError.prototype);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("leave the deterministic variant's 32 zero bytes reachable through deterministic", () => {
		const zeros = new Uint8Array(32);
		expect(mlDsa44.sign({ seed, message, randomness: "deterministic" })).toStrictEqual(
			ml_dsa44.sign(message, secretKey, { extraEntropy: zeros }),
		);
		expect(freshMemoryMismatch()).toBeNull();
	});
});
