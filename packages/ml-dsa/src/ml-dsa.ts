import { checkBytes, checkContext, checkExactBytes, checkRandomness, isAllZero } from "./bytes.js";
import { regionBytes, runCore } from "./core.js";
import {
	writeMessageRepresentative,
	writeVerifierMessageRepresentative,
} from "./message-representative.js";
import * as messages from "./messages.js";
import {
	deriveKeyPair,
	secretKeyPublicKeyHash,
	signMessageRepresentative,
	verifyMessageRepresentative,
} from "./operations.js";
import { readOptions } from "./options.js";
import {
	maxContextBytes,
	parameterSets,
	randomnessBytes,
	seedBytes,
	type ObjectName,
	type ParameterSet,
} from "./parameter-sets.js";

/** The byte lengths of one parameter set's inputs and outputs. */
export interface Lengths<PublicKey extends number, Signature extends number> {
	/** The length of a seed. */
	readonly seed: 32;
	/** The length of the signing randomness. */
	readonly randomness: 32;
	/** The length of an encoded public key. */
	readonly publicKey: PublicKey;
	/** The length of a signature. */
	readonly signature: Signature;
	/** The length of the longest context string that a call accepts. */
	readonly maxContext: 255;
}

/** What {@link MlDsa.keygen} returns. */
export interface KeygenResult {
	/** The encoded public key, a new array that no later call changes. */
	readonly publicKey: Uint8Array<ArrayBuffer>;
}

/** The named arguments of {@link MlDsa.sign}. */
export interface SignOptions {
	/** The 32-byte seed that the secret key derives from. */
	readonly seed: Uint8Array;
	/** The message to sign. */
	readonly message: Uint8Array;
	/** 32 fresh random bytes, or `"deterministic"` for the deterministic variant. */
	readonly randomness: Uint8Array | "deterministic";
	/**
	 * The context string, at most 255 bytes.
	 *
	 * @defaultValue The empty context string.
	 */
	readonly context?: Uint8Array | undefined;
}

/** The named arguments of {@link MlDsa.verify}. */
export interface VerifyOptions {
	/** The signer's encoded public key. */
	readonly publicKey: Uint8Array;
	/** The signed message. */
	readonly message: Uint8Array;
	/** The signature to check. */
	readonly signature: Uint8Array;
	/**
	 * The context string that the message was signed under, at most 255 bytes.
	 *
	 * @defaultValue The empty context string.
	 */
	readonly context?: Uint8Array | undefined;
}

/** One ML-DSA parameter set. The object, its `lengths`, and its functions are frozen. */
export interface MlDsa<Name extends string, PublicKey extends number, Signature extends number> {
	/** The parameter set's name in FIPS 204. */
	readonly parameterSet: Name;
	/** The byte lengths of the inputs and outputs. */
	readonly lengths: Lengths<PublicKey, Signature>;
	/**
	 * Derives the key pair from a seed, as `ML-DSA.KeyGen_internal` in FIPS 204
	 * does, and returns the public key. The same seed always gives the same
	 * key. A seed doesn't record its parameter set, so store the parameter set
	 * with each seed.
	 *
	 * The package draws no randomness. Draw the seed from a cryptographically
	 * secure source, such as `crypto.getRandomValues`. Before it returns or
	 * throws, `keygen` zeroes the copies of the seed and the secret key that it
	 * wrote to WebAssembly memory.
	 *
	 * The checks run in this order, and the first that fails throws: presence,
	 * type, backing, length, then the zero check.
	 *
	 * @param seed The 32-byte seed, a `Uint8Array` from any realm over a
	 * fixed-length, non-shared, non-detached `ArrayBuffer`.
	 * @throws TypeError if `seed` is missing, isn't a `Uint8Array`, or sits on a
	 * shared, resizable, or detached buffer.
	 * @throws RangeError if `seed` isn't 32 bytes long, or if all its bytes are
	 * zero, which catches a seed buffer that was never filled.
	 * @throws Error if the call fails after its checks, with the original error,
	 * or `{ code }` for a non-zero return code from mldsa-native, in `cause`.
	 * @throws The engine's own stack-overflow error, if the caller has used up
	 * the JavaScript stack. By then, `keygen` has zeroed anything that it wrote
	 * to WebAssembly memory. Some engines throw this error as a `RangeError`, so
	 * a `RangeError` alone doesn't prove a bad seed.
	 *
	 * @example
	 * ```ts
	 * const seed = crypto.getRandomValues(new Uint8Array(mlDsa87.lengths.seed));
	 * const { publicKey } = mlDsa87.keygen(seed);
	 * ```
	 */
	readonly keygen: (seed: Uint8Array) => KeygenResult;
	/**
	 * Signs a message with pure ML-DSA, as `ML-DSA.Sign` in FIPS 204 does, but
	 * with signing randomness that the caller supplies. The key pair derives
	 * from the seed inside the call, so no secret key enters or leaves
	 * JavaScript. The message can have any length.
	 *
	 * The package draws no randomness. Draw the signing randomness for each
	 * call from a cryptographically secure source, such as
	 * `crypto.getRandomValues`, or pass `"deterministic"` for the deterministic
	 * variant. Before it returns or throws, `sign` zeroes the copies of the
	 * seed, the secret key, and the signing randomness that it wrote to
	 * WebAssembly memory.
	 *
	 * The checks run in this order, and the first that fails throws. First the
	 * options: their type, their prototype, and their keys. Then `seed`,
	 * `message`, `context`, and `randomness`, in that order. Each input gets
	 * the checks that apply to it, in the order presence, type, backing, then
	 * length: `context` has no presence check, and `message` has no length
	 * check. Then the zero checks, the seed before the randomness. The options
	 * are read once, as own properties only, before any check of an input.
	 *
	 * @param options The seed, the message, the signing randomness, and the
	 * optional context string. Each byte input is a `Uint8Array` from any realm
	 * over a fixed-length, non-shared, non-detached `ArrayBuffer`. The options
	 * object's prototype must be `Object.prototype` or `null`.
	 * @returns The signature, a new array that no later call changes.
	 * @throws TypeError if `options` isn't an object, if its prototype is
	 * neither `Object.prototype` nor `null`, or if it holds any other own key.
	 * @throws TypeError if `seed`, `message`, or `randomness` is missing, if an
	 * input has the wrong type, or if an input sits on a shared, resizable, or
	 * detached buffer.
	 * @throws RangeError if `seed` or `randomness` isn't 32 bytes long, if
	 * `context` is longer than 255 bytes, or if all the bytes of `seed` or
	 * `randomness` are zero, which catches a buffer that was never filled.
	 * @throws Error if the call fails after its checks, with the original error,
	 * or `{ code }` for a failing return value from mldsa-native, in `cause`.
	 * @throws Whatever your own getters and proxy traps throw while `sign` reads
	 * `options`, unchanged, and the engine's `TypeError` for an invalid trap
	 * result.
	 * @throws The engine's own stack-overflow error, if the caller has used up
	 * the JavaScript stack. By then, `sign` has zeroed anything that it wrote
	 * to WebAssembly memory. Some engines throw this error as a `RangeError`, so
	 * a `RangeError` alone doesn't prove a bad input.
	 *
	 * @example
	 * ```ts
	 * const randomness = crypto.getRandomValues(new Uint8Array(mlDsa87.lengths.randomness));
	 * const signature = mlDsa87.sign({ seed, message, randomness });
	 * ```
	 */
	readonly sign: (options: SignOptions) => Uint8Array<ArrayBuffer>;
	/**
	 * Checks a pure ML-DSA signature over a message, as `ML-DSA.Verify` in
	 * FIPS 204 does. The message can have any length.
	 *
	 * `verify` never throws for a bad input. It returns `false` for options
	 * that aren't a plain object, an unknown option, a missing input, a wrong
	 * type, a wrong length, or a shared, resizable, or detached buffer. It also
	 * returns `false` when your own getter or proxy trap throws, or when the
	 * call fails inside the package. So `false` means that the signature wasn't
	 * shown to be valid, not that it was shown to be invalid.
	 *
	 * @param options The signer's public key, the message, the signature, and
	 * the optional context string that the message was signed under. The
	 * options object's prototype must be `Object.prototype` or `null`.
	 * @returns `true` if the signature is valid for the message, the context
	 * string, and the public key, and `false` otherwise.
	 * @throws The engine's own stack-overflow error, if too little JavaScript
	 * stack is left to start `verify`.
	 *
	 * @example
	 * ```ts
	 * const valid = mlDsa87.verify({ publicKey, message, signature });
	 * ```
	 */
	readonly verify: (options: VerifyOptions) => boolean;
}

// The read step reads the known keys in this order, which is also the order
// of the input checks.
const signKeys = ["seed", "message", "context", "randomness"] as const;
const verifyKeys = ["publicKey", "message", "signature", "context"] as const;

function createMlDsa<Key extends ObjectName>(
	objectName: Key,
): MlDsa<
	ParameterSet<Key>["parameterSet"],
	ParameterSet<Key>["publicKey"],
	ParameterSet<Key>["signature"]
> {
	const set: ParameterSet<Key> = parameterSets[objectName];
	const keygenSite = `${objectName}.keygen` as const;
	const signSite = `${objectName}.sign` as const;
	const verifySite = `${objectName}.verify` as const;
	const lengths: Lengths<ParameterSet<Key>["publicKey"], ParameterSet<Key>["signature"]> =
		Object.freeze({
			seed: seedBytes,
			randomness: randomnessBytes,
			publicKey: set.publicKey,
			signature: set.signature,
			maxContext: maxContextBytes,
		});
	// Arrow functions have no `prototype`, so each function's own keys are
	// exactly `length` and `name`.
	const keygen = (seed: Uint8Array): KeygenResult => {
		const seedView = checkExactBytes(keygenSite, "seed", seed, seedBytes);
		if (isAllZero(seedView)) {
			throw new RangeError(messages.allZero(keygenSite, "seed"));
		}
		return runCore(keygenSite, (instance) => {
			const keyPairStatus = deriveKeyPair(instance, set, seedView);
			if (keyPairStatus !== null) {
				return keyPairStatus;
			}
			const publicKey = regionBytes(instance, instance.regions.publicKey).slice(0, set.publicKey);
			return { kind: "done", output: { publicKey } };
		});
	};
	const sign = (options: SignOptions): Uint8Array<ArrayBuffer> => {
		const values = readOptions(signSite, options, signKeys);
		const seedView = checkExactBytes(signSite, "seed", values.get("seed"), seedBytes);
		const messageView = checkBytes(signSite, "message", values.get("message"));
		const contextView = checkContext(signSite, values.get("context"));
		const randomness = checkRandomness(signSite, values.get("randomness"));
		if (isAllZero(seedView)) {
			throw new RangeError(messages.allZero(signSite, "seed"));
		}
		if (randomness !== "deterministic" && isAllZero(randomness)) {
			throw new RangeError(messages.allZero(signSite, "randomness"));
		}
		return runCore(signSite, (instance, initShake) => {
			const keyPairStatus = deriveKeyPair(instance, set, seedView);
			if (keyPairStatus !== null) {
				return keyPairStatus;
			}
			const prefixStatus = writeMessageRepresentative(
				instance,
				initShake,
				secretKeyPublicKeyHash(instance),
				contextView,
				messageView,
			);
			if (prefixStatus !== null) {
				return prefixStatus;
			}
			return signMessageRepresentative(instance, set, randomness);
		});
	};
	const verify = (options: VerifyOptions): boolean => {
		try {
			const values = readOptions(verifySite, options, verifyKeys);
			const publicKeyView = checkExactBytes(
				verifySite,
				"publicKey",
				values.get("publicKey"),
				set.publicKey,
			);
			const messageView = checkBytes(verifySite, "message", values.get("message"));
			const signatureView = checkExactBytes(
				verifySite,
				"signature",
				values.get("signature"),
				set.signature,
			);
			const contextView = checkContext(verifySite, values.get("context"));
			return runCore(verifySite, (instance, initShake) => {
				regionBytes(instance, instance.regions.signature).set(signatureView);
				const prefixStatus = writeVerifierMessageRepresentative(
					instance,
					initShake,
					publicKeyView,
					contextView,
					messageView,
				);
				if (prefixStatus !== null) {
					return prefixStatus;
				}
				return { kind: "done", output: verifyMessageRepresentative(instance, set) };
			});
		} catch {
			return false;
		}
	};
	return Object.freeze({
		parameterSet: set.parameterSet,
		lengths,
		keygen: Object.freeze(keygen),
		sign: Object.freeze(sign),
		verify: Object.freeze(verify),
	});
}

/**
 * ML-DSA-44, the parameter set for NIST security category 2.
 *
 * @example
 * ```ts
 * const seed = crypto.getRandomValues(new Uint8Array(mlDsa44.lengths.seed));
 * const { publicKey } = mlDsa44.keygen(seed);
 * ```
 */
export const mlDsa44: MlDsa<"ML-DSA-44", 1312, 2420> = createMlDsa("mlDsa44");

/**
 * ML-DSA-65, the parameter set for NIST security category 3.
 *
 * @example
 * ```ts
 * const seed = crypto.getRandomValues(new Uint8Array(mlDsa65.lengths.seed));
 * const { publicKey } = mlDsa65.keygen(seed);
 * ```
 */
export const mlDsa65: MlDsa<"ML-DSA-65", 1952, 3309> = createMlDsa("mlDsa65");

/**
 * ML-DSA-87, the parameter set for NIST security category 5. The composite
 * signature id-MLDSA87-ECDSA-P384-SHA512 uses it.
 *
 * @example
 * ```ts
 * const seed = crypto.getRandomValues(new Uint8Array(mlDsa87.lengths.seed));
 * const { publicKey } = mlDsa87.keygen(seed);
 * ```
 */
export const mlDsa87: MlDsa<"ML-DSA-87", 2592, 4627> = createMlDsa("mlDsa87");
