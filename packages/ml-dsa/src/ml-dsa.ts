import { checkSecretBytes, isAllZero } from "./bytes.js";
import { runCore } from "./core.js";
import * as messages from "./messages.js";
import {
	maxContextBytes,
	parameterSets,
	randomnessBytes,
	seedBytes,
	type ObjectName,
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
	 * The context string that the message was signed under.
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
	 * Signs a message with pure ML-DSA. Not implemented yet, so it always
	 * throws.
	 *
	 * @throws Error on every call.
	 */
	readonly sign: (options: SignOptions) => Uint8Array<ArrayBuffer>;
	/**
	 * Checks a pure ML-DSA signature. Not implemented yet, so it always throws.
	 *
	 * @throws Error on every call.
	 */
	readonly verify: (options: VerifyOptions) => boolean;
}

type ParameterSet<Key extends ObjectName> = (typeof parameterSets)[Key];

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
		const seedView = checkSecretBytes(keygenSite, "seed", seed, seedBytes);
		if (isAllZero(seedView)) {
			throw new RangeError(messages.allZero(keygenSite, "seed"));
		}
		return runCore(keygenSite, (instance) => {
			instance.seed.bytes.set(seedView);
			const code = instance.functions[set.keypairExport](
				instance.publicKey.pointer,
				instance.secretKey.pointer,
				instance.seed.pointer,
			);
			if (code !== 0) {
				return { kind: "status", code };
			}
			return {
				kind: "done",
				output: { publicKey: instance.publicKey.bytes.slice(0, set.publicKey) },
			};
		});
	};
	const sign = (_options: SignOptions): Uint8Array<ArrayBuffer> => {
		throw new Error(messages.notImplemented(signSite));
	};
	const verify = (_options: VerifyOptions): boolean => {
		throw new Error(messages.notImplemented(verifySite));
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
