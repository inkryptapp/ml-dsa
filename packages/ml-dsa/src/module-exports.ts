import type { Pointer } from "./brand.js";

/** Derives a key pair from a seed. Returns 0 on success. */
type KeypairInternal = (publicKey: Pointer, secretKey: Pointer, seed: Pointer) => number;

/**
 * Signs a message. With a non-zero `externalMu`, `message` points to a 64-byte
 * message representative instead. Returns 0 on success.
 */
type SignatureInternal = (
	signature: Pointer,
	message: Pointer,
	messageLength: number,
	prefix: Pointer,
	prefixLength: number,
	randomness: Pointer,
	secretKey: Pointer,
	externalMu: number,
) => number;

/** Verifies a signature over a message representative. Returns 0 for a valid signature. */
type VerifyExtmu = (signature: Pointer, mu: Pointer, publicKey: Pointer) => number;

/** Writes the domain-separation prefix and returns its length, or 0 on error. */
type PrepareDomainSeparationPrefix = (
	prefix: Pointer,
	preHash: Pointer,
	preHashLength: number,
	context: Pointer,
	contextLength: number,
	hashAlgorithm: number,
) => number;

/**
 * The function exports of the wasm module, keyed by export name. Each type
 * follows the upstream C declaration at the pin, with every pointer and
 * `size_t` as a wasm32 `i32`.
 */
export interface ModuleFunctions {
	readonly mldsa44_keypair_internal: KeypairInternal;
	readonly mldsa44_signature_internal: SignatureInternal;
	readonly mldsa44_verify_extmu: VerifyExtmu;
	readonly mldsa65_keypair_internal: KeypairInternal;
	readonly mldsa65_signature_internal: SignatureInternal;
	readonly mldsa65_verify_extmu: VerifyExtmu;
	readonly mldsa87_keypair_internal: KeypairInternal;
	readonly mldsa87_signature_internal: SignatureInternal;
	readonly mldsa87_verify_extmu: VerifyExtmu;
	readonly mldsa44_prepare_domain_separation_prefix: PrepareDomainSeparationPrefix;
	readonly mldsa_shake256_init: (state: Pointer) => void;
	readonly mldsa_shake256_absorb: (state: Pointer, input: Pointer, inputLength: number) => void;
	readonly mldsa_shake256_finalize: (state: Pointer) => void;
	readonly mldsa_shake256_squeeze: (output: Pointer, outputLength: number, state: Pointer) => void;
	readonly mldsa_shake256_release: (state: Pointer) => void;
}

/** The name of a function export of the wasm module. */
export type FunctionName = keyof ModuleFunctions;

/** Every export of the wasm module, which imports nothing. */
export interface ModuleExports extends ModuleFunctions {
	readonly memory: WebAssembly.Memory;
	readonly __stack_low: WebAssembly.Global;
	readonly __stack_high: WebAssembly.Global;
	readonly __heap_base: WebAssembly.Global;
	readonly __heap_end: WebAssembly.Global;
}
