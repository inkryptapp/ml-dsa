import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import {
	failNextCreation,
	keyPair,
	messageRepresentative,
	setRecording,
	signExternalMu,
	signFromSecretKey,
	signInternal,
	testRecord,
	verifyExternalMu,
	verifyInternal,
} from "../src/testing.js";
import {
	byteSource,
	freshMemoryMismatch,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
} from "./helpers.js";

for (const { objectName, object, noble } of parameterSetCases) {
	const bytes = byteSource(0x5eed_0060);
	const seed = seedFrom(60);
	const message = bytes(385);
	const context = bytes(33);
	const randomness = bytes(32);
	// FIPS 204 frames a pure ML-DSA message as a zero byte, the context
	// string's length, the context string, then the message.
	const framed = new Uint8Array([0, context.length, ...context, ...message]);

	describe(`the test-only ${objectName} functions`, () => {
		test("derives the key pair that noble derives, from any seed, the all-zero seed included", () => {
			for (const input of [seed, new Uint8Array(32)]) {
				const expected = noble.keygen(input);
				expect(keyPair(objectName, input)).toStrictEqual({
					publicKey: expected.publicKey,
					secretKey: expected.secretKey,
				});
				expect(freshMemoryMismatch()).toBeNull();
			}
		});

		test("signs from the secret key as the public sign does from its seed", () => {
			const { secretKey } = keyPair(objectName, seed);
			for (const mode of [randomness, "deterministic"] as const) {
				expect(
					signFromSecretKey(objectName, { secretKey, message, context, randomness: mode }),
				).toStrictEqual(object.sign({ seed, message, context, randomness: mode }));
				expect(freshMemoryMismatch()).toBeNull();
			}
		});

		test("signs the framed message internally, and its message representative as external mu, as the public sign does", () => {
			const { publicKey, secretKey } = keyPair(objectName, seed);
			const expected = object.sign({ seed, message, context, randomness });
			const mu = messageRepresentative(objectName, { publicKey, message, context });
			expect(signInternal(objectName, { secretKey, message: framed, randomness })).toStrictEqual(
				expected,
			);
			expect(
				signExternalMu(objectName, { secretKey, messageRepresentative: mu, randomness }),
			).toStrictEqual(expected);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("verifies internally and as external mu exactly what the public verify accepts", () => {
			const { publicKey } = keyPair(objectName, seed);
			const signature = object.sign({ seed, message, context, randomness });
			const mu = messageRepresentative(objectName, { publicKey, message, context });
			const flipped = signature.slice();
			flipped[0] = (flipped[0] ?? 0) ^ 1;
			for (const [candidate, valid] of [
				[signature, true],
				[flipped, false],
			] as const) {
				expect(object.verify({ publicKey, message, context, signature: candidate })).toBe(valid);
				expect(
					verifyInternal(objectName, { publicKey, message: framed, signature: candidate }),
				).toBe(valid);
				expect(
					verifyExternalMu(objectName, {
						publicKey,
						messageRepresentative: mu,
						signature: candidate,
					}),
				).toBe(valid);
			}
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("throws RangeError for a secret key of the wrong length in each signing function", () => {
			const { secretKey } = keyPair(objectName, seed);
			const mu = new Uint8Array(64);
			const signs = [
				(wrong: Uint8Array) =>
					signFromSecretKey(objectName, { secretKey: wrong, message, randomness }),
				(wrong: Uint8Array) => signInternal(objectName, { secretKey: wrong, message, randomness }),
				(wrong: Uint8Array) =>
					signExternalMu(objectName, { secretKey: wrong, messageRepresentative: mu, randomness }),
			];
			const wrongKeys = [secretKey.subarray(1), new Uint8Array([...secretKey, 0])];
			for (const sign of signs) {
				for (const wrong of wrongKeys) {
					const error = thrown(() => sign(wrong));
					expect(prototypeOf(error)).toBe(RangeError.prototype);
					expect(error).toHaveProperty(
						"message",
						`${objectName}.sign: secretKey must be ${secretKey.length} bytes long.`,
					);
					expect(freshMemoryMismatch()).toBeNull();
				}
			}
		});

		test("throws RangeError for a message representative that isn't 64 bytes long", () => {
			const { secretKey } = keyPair(objectName, seed);
			const error = thrown(() =>
				signExternalMu(objectName, { secretKey, messageRepresentative: bytes(63), randomness }),
			);
			expect(prototypeOf(error)).toBe(RangeError.prototype);
			expect(error).toHaveProperty(
				"message",
				`${objectName}.sign: messageRepresentative must be 64 bytes long.`,
			);
		});

		test("throws RangeError for a signature or a message representative of the wrong length in each verification function", () => {
			const { publicKey } = keyPair(objectName, seed);
			const signature = object.sign({ seed, message, randomness });
			const short = signature.subarray(1);
			const mu = messageRepresentative(objectName, { publicKey, message });
			const cases = [
				["signature", () => verifyInternal(objectName, { publicKey, message, signature: short })],
				[
					"signature",
					() =>
						verifyExternalMu(objectName, {
							publicKey,
							messageRepresentative: mu,
							signature: short,
						}),
				],
				[
					"messageRepresentative",
					() =>
						verifyExternalMu(objectName, {
							publicKey,
							messageRepresentative: mu.subarray(1),
							signature,
						}),
				],
			] as const;
			for (const [input, verify] of cases) {
				const error = thrown(verify);
				const length = input === "signature" ? signature.length : 64;
				expect(prototypeOf(error)).toBe(RangeError.prototype);
				expect(error).toHaveProperty(
					"message",
					`${objectName}.verify: ${input} must be ${length} bytes long.`,
				);
				expect(freshMemoryMismatch()).toBeNull();
			}
		});
	});
}

describe("the recording switch", () => {
	test("turns the test record on, and turning it off clears the record", () => {
		const verifyOptions = {
			publicKey: new Uint8Array(mlDsa44.lengths.publicKey),
			message: new Uint8Array(0),
			signature: new Uint8Array(mlDsa44.lengths.signature),
		};
		const injected = new Error("injected");
		try {
			setRecording(true);
			expect(testRecord()).toBeNull();
			failNextCreation(injected);
			expect(mlDsa44.verify(verifyOptions)).toBe(false);
			expect(testRecord()).toStrictEqual({ failure: injected, dropped: false });

			setRecording(false);
			expect(testRecord()).toBeNull();
			failNextCreation(injected);
			expect(mlDsa44.verify(verifyOptions)).toBe(false);
			expect(testRecord()).toBeNull();
		} finally {
			setRecording(false);
		}
		const seed = seedFrom(61);
		expect(mlDsa44.keygen(seed)).toStrictEqual({ publicKey: ml_dsa44.keygen(seed).publicKey });
		expect(freshMemoryMismatch()).toBeNull();
	});
});
