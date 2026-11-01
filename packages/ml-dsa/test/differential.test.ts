import { describe, expect, test } from "vite-plus/test";

import sizes from "../wasm/sizes.json" with { type: "json" };
import {
	byteSource,
	freshMemoryMismatch,
	parameterSetCases,
	prototypeOf,
	thrown,
	type ParameterSetCase,
} from "./helpers.js";

// noble 0.7.1 is the reference. When it and the package disagree, the ACVP
// and Wycheproof vectors decide which one is wrong.

const chunk = sizes.chunkBytes;

/** The SHAKE256 rate, the size of one Keccak block. */
const rateBytes = 136;

/**
 * How many bytes the message representative absorbs before the message, for a
 * context string of `contextLength` bytes: the 64-byte public-key hash, then
 * the prefix, which is a zero byte, the context length, and the context string.
 */
const beforeMessage = (contextLength: number): number => 64 + 2 + contextLength;

/**
 * The shortest context length that puts a rate-block boundary at the start of
 * chunk `index` of the message. Index 0 is the message's start.
 */
function contextAligningChunk(index: number): number {
	for (let contextLength = 0; contextLength <= 255; contextLength += 1) {
		if ((beforeMessage(contextLength) + index * chunk) % rateBytes === 0) {
			return contextLength;
		}
	}
	throw new Error(`No context string aligns chunk ${index}.`);
}

/** Which of the message's first three chunk starts a context length puts on a rate-block boundary. */
function alignedChunks(contextLength: number): readonly number[] {
	return [0, 1, 2].filter(
		(index) => (beforeMessage(contextLength) + index * chunk) % rateBytes === 0,
	);
}

const untargetedContexts = [0, 1, 33, 255];
const targetedContexts = [
	contextAligningChunk(0),
	contextAligningChunk(1),
	contextAligningChunk(2),
];
const contextLengths = [...untargetedContexts, ...targetedContexts].toSorted((a, b) => a - b);
const messageLengths = [0, 1, 385, chunk - 1, chunk, chunk + 1, 2 * chunk, 2 * chunk + 1, 204_800];
const modes = ["hedged", "deterministic"] as const;

/** One signing case of the differential list. */
interface SigningCase {
	readonly seed: Uint8Array<ArrayBuffer>;
	readonly message: Uint8Array<ArrayBuffer>;
	readonly context: Uint8Array<ArrayBuffer>;
	readonly randomness: Uint8Array<ArrayBuffer> | "deterministic";
}

/** noble's signature for a case, with the randomness as `extraEntropy`. */
function nobleSignature(noble: ParameterSetCase["noble"], signing: SigningCase): Uint8Array {
	const { secretKey } = noble.keygen(signing.seed);
	return noble.sign(signing.message, secretKey, {
		context: signing.context,
		extraEntropy: signing.randomness === "deterministic" ? false : signing.randomness,
	});
}

/**
 * Signs a case with the package and with noble, and expects equal signatures,
 * each side's acceptance of the other's signature, and fresh memory after
 * each call.
 */
function expectAgreement({ object, noble }: ParameterSetCase, signing: SigningCase): void {
	const signature = object.sign(signing);
	expect(freshMemoryMismatch()).toBeNull();
	expect(signature).toStrictEqual(nobleSignature(noble, signing));
	const { publicKey } = object.keygen(signing.seed);
	expect(freshMemoryMismatch()).toBeNull();
	const { message, context } = signing;
	expect(object.verify({ publicKey, message, context, signature })).toBe(true);
	expect(freshMemoryMismatch()).toBeNull();
	expect(noble.verify(signature, message, publicKey, { context })).toBe(true);
}

// noble is slow, and these tests call it many times, some with messages of
// several chunks, so they get a longer limit than Vitest's 5-second default.
const listTimeout = 120_000;

describe("the differential list", () => {
	test("aligns each targeted context with a chunk start, and no untargeted one", () => {
		expect(targetedContexts.map(alignedChunks)).toStrictEqual([[0], [1], [2]]);
		expect(untargetedContexts.map(alignedChunks)).toStrictEqual([[], [], [], []]);
	});

	test("has 378 cases", () => {
		expect(
			parameterSetCases.length * messageLengths.length * contextLengths.length * modes.length,
		).toBe(378);
	});

	test.each(parameterSetCases)(
		"$objectName signs every case as noble does",
		(parameterSet) => {
			const bytes = byteSource(0x5eed_0001);
			const messages = messageLengths.map((length) => bytes(length));
			for (const message of messages) {
				for (const contextLength of contextLengths) {
					for (const mode of modes) {
						expectAgreement(parameterSet, {
							seed: bytes(32),
							message,
							context: bytes(contextLength),
							randomness: mode === "deterministic" ? "deterministic" : bytes(32),
						});
					}
				}
			}
		},
		listTimeout,
	);
});

describe.each(parameterSetCases)("the $objectName mutation subset", ({ object, noble }) => {
	const bytes = byteSource(0x5eed_0002);
	const seed = bytes(32);
	const message = bytes(385);
	const context = bytes(33);
	const { publicKey } = object.keygen(seed);

	/** Flips one bit of a copy of `source`. */
	function flipped(source: Uint8Array, offset: number): Uint8Array<ArrayBuffer> {
		const copy = source.slice();
		copy[offset] = (copy[offset] ?? 0) ^ 0x10;
		return copy;
	}

	test.each(modes)("both verify functions reject each mutation of a %s signature", (mode) => {
		const randomness = mode === "deterministic" ? "deterministic" : bytes(32);
		const signature = object.sign({ seed, message, context, randomness });
		const rejected = [
			{ publicKey, message, context, signature: flipped(signature, 100) },
			{ publicKey: flipped(publicKey, 40), message, context, signature },
			{ publicKey, message: flipped(message, 0), context, signature },
			{ publicKey, message, context: flipped(context, 32), signature },
			{ publicKey, message, context: context.slice(1), signature },
			{ publicKey, message, context, signature: signature.slice(0, -1) },
		];
		for (const options of rejected) {
			expect(object.verify(options)).toBe(false);
			expect(freshMemoryMismatch()).toBeNull();
			expect(
				noble.verify(options.signature, options.message, options.publicKey, {
					context: options.context,
				}),
			).toBe(false);
		}

		// noble throws for these, and the package returns false.
		const nobleThrows = [
			{ publicKey: publicKey.slice(0, -1), message, context, signature },
			{ publicKey, message, context: bytes(256), signature },
		];
		for (const options of nobleThrows) {
			expect(object.verify(options)).toBe(false);
			expect(freshMemoryMismatch()).toBeNull();
			const error = thrown(() =>
				noble.verify(options.signature, options.message, options.publicKey, {
					context: options.context,
				}),
			);
			expect(prototypeOf(error)).toBe(RangeError.prototype);
		}
	});
});

// A run prints its seed, which is fresh unless the environment variable sets
// one, so a failing batch can run again.
const batchSeedVariable = "ML_DSA_DIFFERENTIAL_SEED";
const batchSeed =
	Number(process.env[batchSeedVariable] ?? "") ||
	crypto.getRandomValues(new Uint32Array(1)).at(0) ||
	1;

test(
	`a seeded random batch agrees with noble (${batchSeedVariable}=${batchSeed})`,
	() => {
		console.info(`The random differential batch runs with ${batchSeedVariable}=${batchSeed}.`);
		const bytes = byteSource(batchSeed);
		// A number below `count`, from 24 random bits.
		const pick = (count: number): number => {
			const [high = 0, middle = 0, low = 0] = bytes(3);
			return ((high << 16) | (middle << 8) | low) % count;
		};
		for (let index = 0; index < 24; index += 1) {
			const parameterSet = parameterSetCases[pick(parameterSetCases.length)];
			if (parameterSet === undefined) {
				throw new Error("No parameter set was picked.");
			}
			expectAgreement(parameterSet, {
				seed: bytes(32),
				message: bytes(pick(4 * chunk + 1)),
				context: bytes(pick(256)),
				randomness: pick(2) === 0 ? "deterministic" : bytes(32),
			});
		}
	},
	listTimeout,
);
