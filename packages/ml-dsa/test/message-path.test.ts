import { createHash } from "node:crypto";

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { afterEach, describe, expect, test } from "vite-plus/test";

import sizes from "../wasm/sizes.json" with { type: "json" };
import { mlDsa44 } from "../src/index.js";
import {
	currentMemory,
	layout,
	messageRepresentative,
	rawExports,
	setExportHook,
	type ExportHook,
} from "../src/testing.js";
import type { FunctionName } from "../src/module-exports.js";
import { parameterSets } from "../src/parameter-sets.js";
import {
	byteSource,
	freshMemoryMismatch,
	isAllZero,
	parameterSetCases,
	prototypeOf,
	regionOf,
	seedFrom,
	thrown,
	wipeAfterRawCall,
} from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

/** SHAKE256 of the parts, squeezed to 64 bytes, from Node's own implementation. */
function shake256(...parts: readonly Uint8Array[]): Uint8Array {
	const hash = createHash("shake256", { outputLength: 64 });
	for (const part of parts) {
		hash.update(part);
	}
	return new Uint8Array(hash.digest());
}

describe("the message representative", () => {
	const chunk = sizes.chunkBytes;
	const bytes = byteSource(0x5eed_0003);
	const messages = [0, 1, chunk - 1, chunk, chunk + 1, 2 * chunk + 1].map((length) =>
		bytes(length),
	);
	const contexts = [0, 33, 255].map((length) => bytes(length));

	test.each(parameterSetCases)(
		"of $objectName hashes the public-key hash, the prefix, and the message",
		({ objectName, object }) => {
			const { publicKey } = object.keygen(seedFrom(30));
			for (const message of messages) {
				for (const context of contexts) {
					const prefix = new Uint8Array([0, context.length]);
					const expected = shake256(shake256(publicKey), prefix, context, message);
					expect(messageRepresentative(objectName, { publicKey, message, context })).toStrictEqual(
						expected,
					);
					expect(freshMemoryMismatch()).toBeNull();
				}
			}
		},
	);
});

describe("the public-key hash in a derived secret key", () => {
	test.each(parameterSetCases)(
		"of $objectName sits where sign reads it",
		({ objectName, object }) => {
			const raw = rawExports();
			const memory = currentMemory();
			if (raw === null || memory === null) {
				throw new Error("The slot is empty.");
			}
			const { seed, publicKey, secretKey } = layout.regions;
			regionOf(memory, seed).set(seedFrom(31));
			const code = raw[parameterSets[objectName].keypairExport](
				publicKey.pointer,
				secretKey.pointer,
				seed.pointer,
			);
			expect(code).toBe(0);
			const derivedPublicKey = regionOf(memory, publicKey).slice(0, object.lengths.publicKey);
			const start = secretKey.pointer + layout.publicKeyHashOffset;
			expect(memory.slice(start, start + 64)).toStrictEqual(shake256(derivedPublicKey));

			wipeAfterRawCall(memory);
			expect(freshMemoryMismatch()).toBeNull();
		},
	);
});

describe("the SHAKE256 release", () => {
	const seed = seedFrom(32);
	const message = new Uint8Array([7, 8, 9]);
	const { publicKey, secretKey } = ml_dsa44.keygen(seed);
	const reference = ml_dsa44.sign(message, secretKey, { extraEntropy: false });
	const signOptions = { seed, message, randomness: "deterministic" } as const;
	const verifyOptions = { publicKey, message, signature: reference };
	const proceed: ExportHook = (call) => call.proceed();
	const signFailure = (): unknown => thrown(() => mlDsa44.sign(signOptions));

	/**
	 * Runs `action` with `hook` in place of each export call, and returns what
	 * `action` returned and how many releases ran.
	 */
	function hooked(
		hook: ExportHook,
		action: () => unknown,
	): { readonly result: unknown; readonly releases: number } {
		let releases = 0;
		setExportHook((call) => {
			if (call.name === "mldsa_shake256_release") {
				releases += 1;
			}
			return hook(call);
		});
		try {
			const result = action();
			return { result, releases };
		} finally {
			setExportHook(null);
		}
	}

	/** A hook that runs every export, and replaces the return value of `name` with `result`. */
	function returning(name: FunctionName, result: number): ExportHook {
		return (call) => {
			const proceeded = call.proceed();
			return call.name === name ? result : proceeded;
		};
	}

	/** Expects the plain package `Error` that a failed `mlDsa44.sign` call throws, with `cause`. */
	function expectSignFailed(error: unknown, cause: unknown): void {
		expect(prototypeOf(error)).toBe(Error.prototype);
		expect(error).toHaveProperty("message", "mlDsa44.sign: the call failed.");
		expect(error).toHaveProperty("cause", cause);
	}

	test("runs exactly once in each healthy sign and verify, and never in keygen", () => {
		const flipped = reference.slice();
		flipped[0] = (flipped[0] ?? 0) ^ 1;
		const calls: readonly (readonly [() => unknown, unknown, number])[] = [
			[() => mlDsa44.sign(signOptions), reference, 1],
			[() => mlDsa44.verify(verifyOptions), true, 1],
			[() => mlDsa44.verify({ ...verifyOptions, signature: flipped }), false, 1],
			[() => mlDsa44.keygen(seed).publicKey, publicKey, 0],
		];
		for (const [action, expected, releases] of calls) {
			expect(hooked(proceed, action)).toStrictEqual({ result: expected, releases });
			expect(freshMemoryMismatch()).toBeNull();
		}
	});

	test("runs before the fills, while the state and the message representative remain", () => {
		const { shakeState, messageRepresentative: representative } = layout.regions;
		const seen: { state?: boolean; representative?: boolean } = {};
		const { result } = hooked(
			(call) => {
				if (call.name === "mldsa_shake256_release") {
					seen.state = !isAllZero(regionOf(call.memory, shakeState));
					seen.representative = !isAllZero(regionOf(call.memory, representative));
				}
				return call.proceed();
			},
			() => mlDsa44.sign(signOptions),
		);
		expect(result).toStrictEqual(reference);
		expect(seen).toStrictEqual({ state: true, representative: true });
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("doesn't run when a status comes before any SHAKE256 init", () => {
		const before = currentMemory();
		const { result, releases } = hooked(returning("mldsa44_keypair_internal", 7), signFailure);
		expectSignFailed(result, { code: 7 });
		expect(releases).toBe(0);
		expect(currentMemory()).toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("runs after a signing status, which stays the cause", () => {
		const before = currentMemory();
		const { result, releases } = hooked(returning("mldsa44_signature_internal", 5), signFailure);
		expectSignFailed(result, { code: 5 });
		expect(releases).toBe(1);
		expect(currentMemory()).toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("follows a zero prefix length, which is a status, only if an init came first", () => {
		const zeroPrefix = returning("mldsa44_prepare_domain_separation_prefix", 0);
		const before = currentMemory();
		const signed = hooked(zeroPrefix, signFailure);
		expectSignFailed(signed.result, { code: 0 });
		expect(signed.releases).toBe(0);
		// verify hashes the public key before it asks for the prefix.
		expect(hooked(zeroPrefix, () => mlDsa44.verify(verifyOptions))).toStrictEqual({
			result: false,
			releases: 1,
		});
		expect(currentMemory()).toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("doesn't run when the init throws, because the call poisons the instance", () => {
		const injected = new RangeError("injected");
		const before = currentMemory();
		const { result, releases } = hooked((call) => {
			if (call.name === "mldsa_shake256_init") {
				throw injected;
			}
			return call.proceed();
		}, signFailure);
		expectSignFailed(result, injected);
		expect(releases).toBe(0);
		expect(before === null ? false : isAllZero(before)).toBe(true);
		expect(currentMemory()).toBeNull();
		expect(mlDsa44.sign(signOptions)).toStrictEqual(reference);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test.each([
		["a healthy call", proceed, (injected: unknown): unknown => injected],
		[
			"a call that ended with a status",
			returning("mldsa44_signature_internal", 5),
			() => ({ code: 5 }),
		],
	])("that throws poisons %s, and the first failure stays the cause", (_, hook, expectedCause) => {
		const injected = new RangeError("release");
		const before = currentMemory();
		const { result } = hooked((call) => {
			if (call.name === "mldsa_shake256_release") {
				call.proceed();
				throw injected;
			}
			return hook(call);
		}, signFailure);
		expectSignFailed(result, expectedCause(injected));
		expect(before === null ? false : isAllZero(before)).toBe(true);
		expect(currentMemory()).toBeNull();
		expect(mlDsa44.sign(signOptions)).toStrictEqual(reference);
		expect(freshMemoryMismatch()).toBeNull();
	});
});
