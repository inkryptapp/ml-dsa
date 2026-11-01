import { nullPointer, type Pointer } from "./brand.js";
import { regionBytes, type InitShake, type Instance, type Status } from "./core.js";
import { messageRepresentativeBytes, publicKeyHashBytes, pureMlDsa } from "./upstream.js";

/**
 * Writes the message representative of pure ML-DSA to the
 * `messageRepresentative` region. It absorbs the public-key hash at
 * `publicKeyHash`, then the domain-separation prefix for `context`, then the
 * message, into one SHAKE256 state, and squeezes 64 bytes. The message streams
 * through the `chunk` region, so its length has no cap.
 *
 * `sign`, `verify`, and the test-only signing from a secret key compute the
 * message representative of pure ML-DSA here.
 *
 * @returns `null`, or a status with code 0 if the prefix function returned a
 * zero length. Only an internal error can cause that, because the context's
 * length is checked before the call. Nothing is absorbed then.
 */
export function writeMessageRepresentative(
	instance: Instance,
	initShake: InitShake,
	publicKeyHash: Pointer,
	context: Uint8Array,
	message: Uint8Array,
): Status | null {
	const { regions, functions } = instance;
	regionBytes(instance, regions.context).set(context);
	// The prefix doesn't depend on the parameter set, so every parameter set
	// calls the ML-DSA-44 copy. Upstream compiles one copy per parameter set,
	// and the module exports only this one.
	const prefixLength = functions.mldsa44_prepare_domain_separation_prefix(
		regions.prefix.pointer,
		nullPointer,
		0,
		regions.context.pointer,
		context.length,
		pureMlDsa,
	);
	if (prefixLength === 0) {
		return { kind: "status", code: prefixLength };
	}
	absorbMessageRepresentative(instance, initShake, publicKeyHash, prefixLength, message);
	return null;
}

/**
 * Writes the message representative that `ML-DSA.Sign_internal` and
 * `ML-DSA.Verify_internal` in FIPS 204 compute from the message that they
 * take, with the same absorb order as {@link writeMessageRepresentative} and
 * an empty domain-separation prefix. Only the test-only entry point calls it.
 */
export function writeInternalMessageRepresentative(
	instance: Instance,
	initShake: InitShake,
	publicKeyHash: Pointer,
	message: Uint8Array,
): void {
	absorbMessageRepresentative(instance, initShake, publicKeyHash, 0, message);
}

/**
 * Absorbs the public-key hash, the first `prefixLength` bytes of the `prefix`
 * region, and the message into a new SHAKE256 state, and squeezes the message
 * representative into its region. Pure ML-DSA and the internal interface both
 * absorb through it, so the absorb order lives in one place.
 */
function absorbMessageRepresentative(
	instance: Instance,
	initShake: InitShake,
	publicKeyHash: Pointer,
	prefixLength: number,
	message: Uint8Array,
): void {
	const { regions, functions } = instance;
	const state = regions.shakeState.pointer;
	const chunk = regionBytes(instance, regions.chunk);
	const chunkBytes = regions.chunk.length;
	const messageLength = message.length;
	initShake();
	functions.mldsa_shake256_absorb(state, publicKeyHash, publicKeyHashBytes);
	functions.mldsa_shake256_absorb(state, regions.prefix.pointer, prefixLength);
	for (let offset = 0; offset < messageLength; offset += chunkBytes) {
		const chunkLength = Math.min(chunkBytes, messageLength - offset);
		chunk.set(message.subarray(offset, offset + chunkLength));
		functions.mldsa_shake256_absorb(state, regions.chunk.pointer, chunkLength);
	}
	functions.mldsa_shake256_finalize(state);
	functions.mldsa_shake256_squeeze(
		regions.messageRepresentative.pointer,
		messageRepresentativeBytes,
		state,
	);
}

/**
 * Copies the public key into the `publicKey` region and writes its public-key
 * hash to the `publicKeyHash` region.
 */
export function writePublicKeyHash(
	instance: Instance,
	initShake: InitShake,
	publicKey: Uint8Array,
): void {
	const { regions, functions } = instance;
	const state = regions.shakeState.pointer;
	regionBytes(instance, regions.publicKey).set(publicKey);
	initShake();
	functions.mldsa_shake256_absorb(state, regions.publicKey.pointer, publicKey.length);
	functions.mldsa_shake256_finalize(state);
	functions.mldsa_shake256_squeeze(regions.publicKeyHash.pointer, publicKeyHashBytes, state);
}

/**
 * Writes the message representative that `verify` checks a signature against.
 * It calls {@link writePublicKeyHash}, then {@link writeMessageRepresentative}
 * with that hash.
 *
 * @returns What {@link writeMessageRepresentative} returns.
 */
export function writeVerifierMessageRepresentative(
	instance: Instance,
	initShake: InitShake,
	publicKey: Uint8Array,
	context: Uint8Array,
	message: Uint8Array,
): Status | null {
	writePublicKeyHash(instance, initShake, publicKey);
	return writeMessageRepresentative(
		instance,
		initShake,
		instance.regions.publicKeyHash.pointer,
		context,
		message,
	);
}
