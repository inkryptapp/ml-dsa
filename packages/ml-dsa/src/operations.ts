// The steps of `keygen`, `sign`, and `verify` that run on an instance inside
// a call's work. The public API and the test-only entry point share them.

import { nullPointer, pointer, type Pointer } from "./brand.js";
import { regionBytes, type Instance, type Outcome, type Status } from "./core.js";
import type { ParameterSet } from "./parameter-sets.js";
import { messageRepresentativeBytes, publicKeyHashOffset } from "./upstream.js";

/**
 * Copies the seed into its region and derives the key pair into the
 * `publicKey` and `secretKey` regions.
 *
 * @returns `null`, or the status of a non-zero return code.
 */
export function deriveKeyPair(
	instance: Instance,
	set: ParameterSet,
	seed: Uint8Array,
): Status | null {
	const { regions, functions } = instance;
	regionBytes(instance, regions.seed).set(seed);
	const code = functions[set.keypairExport](
		regions.publicKey.pointer,
		regions.secretKey.pointer,
		regions.seed.pointer,
	);
	return code === 0 ? null : { kind: "status", code };
}

/** Where the public-key hash sits in the secret key in the `secretKey` region. */
export function secretKeyPublicKeyHash(instance: Instance): Pointer {
	return pointer(instance.regions.secretKey.pointer + publicKeyHashOffset);
}

/**
 * Signs the message representative in its region with the secret key in its
 * region, and returns a copy of the signature.
 *
 * @returns The signature, or the status of a non-zero return code.
 */
export function signMessageRepresentative(
	instance: Instance,
	set: ParameterSet,
	randomness: Uint8Array | "deterministic",
): Outcome<Uint8Array<ArrayBuffer>> {
	const { regions, functions } = instance;
	const randomnessRegion = regionBytes(instance, regions.randomness);
	if (randomness === "deterministic") {
		randomnessRegion.fill(0);
	} else {
		randomnessRegion.set(randomness);
	}
	// The last argument asks for external mu, so upstream reads the message
	// representative in place of a message and ignores the prefix arguments.
	const code = functions[set.signatureExport](
		regions.signature.pointer,
		regions.messageRepresentative.pointer,
		messageRepresentativeBytes,
		nullPointer,
		0,
		regions.randomness.pointer,
		regions.secretKey.pointer,
		1,
	);
	if (code !== 0) {
		return { kind: "status", code };
	}
	return { kind: "done", output: regionBytes(instance, regions.signature).slice(0, set.signature) };
}

/**
 * Checks the signature in its region against the message representative in
 * its region, with the public key in its region.
 */
export function verifyMessageRepresentative(instance: Instance, set: ParameterSet): boolean {
	const { regions, functions } = instance;
	const code = functions[set.verifyExport](
		regions.signature.pointer,
		regions.messageRepresentative.pointer,
		regions.publicKey.pointer,
	);
	return code === 0;
}
