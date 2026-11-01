import { describe, expect, test } from "vite-plus/test";

import {
	byteSource,
	freshMemoryMismatch,
	parameterSetCases,
	seedFrom,
	untypedFunction,
} from "./helpers.js";
import { acceptedForms, badBackings, countingProxy, watchedReads, wrongTypes } from "./inputs.js";

const keys = ["publicKey", "message", "signature", "context"] as const;

for (const { objectName, object, noble } of parameterSetCases) {
	describe(`${objectName}.verify`, () => {
		const bytes = byteSource(0x5eed_0020);
		const seed = seedFrom(20);
		const message = bytes(385);
		const context = bytes(33);
		const { publicKey, secretKey } = noble.keygen(seed);
		const signature = noble.sign(message, secretKey, { context, extraEntropy: bytes(32) });
		const valid = { publicKey, message, signature, context };
		const verify = untypedFunction(object, "verify");

		/** Expects `verify(options)` to return `false`, and memory to stay fresh. */
		function expectRejected(options: unknown): void {
			expect(verify(options)).toBe(false);
			expect(freshMemoryMismatch()).toBeNull();
		}

		test("accepts noble's signature and its own", () => {
			expect(object.verify(valid)).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
			const own = object.sign({ seed, message, context, randomness: "deterministic" });
			expect(object.verify({ ...valid, signature: own })).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("checks the signature under the empty context string when context is missing", () => {
			const empty = noble.sign(message, secretKey, { extraEntropy: false });
			expect(object.verify({ publicKey, message, signature: empty })).toBe(true);
			expect(object.verify({ publicKey, message, signature: empty, context: undefined })).toBe(
				true,
			);
			expect(object.verify({ publicKey, message, signature })).toBe(false);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("rejects a signature with one flipped bit", () => {
			const flipped = signature.slice();
			flipped[17] = (flipped[17] ?? 0) ^ 0x04;
			expectRejected({ ...valid, signature: flipped });
		});

		test.each(keys)(
			"reads exactly the own bytes of %s, whatever its realm, class, or own properties",
			(key) => {
				const before = { ...watchedReads };
				for (const [, form] of acceptedForms(valid[key])) {
					expect(verify({ ...valid, [key]: form })).toBe(true);
					expect(freshMemoryMismatch()).toBeNull();
				}
				expect(watchedReads).toStrictEqual(before);
			},
		);

		test.each(["publicKey", "message", "signature"] as const)(
			"returns false for a missing %s",
			(key) => {
				const { [key]: _, ...rest } = valid;
				expectRejected(rest);
				expectRejected({ ...rest, [key]: undefined });
			},
		);

		test.each(keys)("returns false for each wrong type of %s", (key) => {
			for (const [, value] of wrongTypes(valid[key])) {
				expectRejected({ ...valid, [key]: value });
			}
		});

		test.each(keys)(
			"returns false for a Proxy of a Uint8Array as %s, and runs none of its traps",
			(key) => {
				const { proxy, counts } = countingProxy(new Uint8Array(valid[key]));
				expectRejected({ ...valid, [key]: proxy });
				expect(Object.fromEntries(counts)).toStrictEqual({});
			},
		);

		test.each(keys)("returns false for %s on a shared, resizable, or detached buffer", (key) => {
			for (const [, value] of badBackings(valid[key])) {
				expectRejected({ ...valid, [key]: value });
			}
		});

		test("returns false for a public key or signature of the wrong length", () => {
			for (const delta of [-1, 1]) {
				const resizedKey = new Uint8Array(publicKey.length + delta);
				resizedKey.set(publicKey.subarray(0, resizedKey.length));
				expectRejected({ ...valid, publicKey: resizedKey });
				const resizedSignature = new Uint8Array(signature.length + delta);
				resizedSignature.set(signature.subarray(0, resizedSignature.length));
				expectRejected({ ...valid, signature: resizedSignature });
			}
			expectRejected({ ...valid, publicKey: new Uint8Array(0) });
			expectRejected({ ...valid, signature: new Uint8Array(0) });
		});

		test("returns false for a context longer than 255 bytes", () => {
			expectRejected({ ...valid, context: bytes(256) });
		});

		test("accepts a signature made under the all-zero seed", () => {
			const zeroSeed = new Uint8Array(32);
			const zeroKeys = noble.keygen(zeroSeed);
			const zeroSigned = noble.sign(message, zeroKeys.secretKey, { extraEntropy: false });
			expect(object.verify({ publicKey: zeroKeys.publicKey, message, signature: zeroSigned })).toBe(
				true,
			);
			expect(freshMemoryMismatch()).toBeNull();
		});
	});
}
