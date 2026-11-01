/** The length of a seed, the same for every parameter set. */
export const seedBytes = 32;

/** The length of the signing randomness, the same for every parameter set. */
export const randomnessBytes = 32;

/** The longest context string that FIPS 204 allows. */
export const maxContextBytes = 255;

/**
 * The three parameter sets, keyed by the name of their exported object. Each
 * holds its FIPS 204 name as `parameterSet`, its lengths from FIPS 204,
 * Table 2, and its export names.
 */
export const parameterSets = {
	mlDsa44: {
		parameterSet: "ML-DSA-44",
		publicKey: 1312,
		secretKey: 2560,
		signature: 2420,
		keypairExport: "mldsa44_keypair_internal",
		signatureExport: "mldsa44_signature_internal",
		verifyExport: "mldsa44_verify_extmu",
	},
	mlDsa65: {
		parameterSet: "ML-DSA-65",
		publicKey: 1952,
		secretKey: 4032,
		signature: 3309,
		keypairExport: "mldsa65_keypair_internal",
		signatureExport: "mldsa65_signature_internal",
		verifyExport: "mldsa65_verify_extmu",
	},
	mlDsa87: {
		parameterSet: "ML-DSA-87",
		publicKey: 2592,
		secretKey: 4896,
		signature: 4627,
		keypairExport: "mldsa87_keypair_internal",
		signatureExport: "mldsa87_signature_internal",
		verifyExport: "mldsa87_verify_extmu",
	},
} as const;

/** The name of an exported object, such as `mlDsa44`. */
export type ObjectName = keyof typeof parameterSets;

/** The entry of {@link parameterSets} for `Key`, or any entry by default. */
export type ParameterSet<Key extends ObjectName = ObjectName> = (typeof parameterSets)[Key];

/** The largest value of one length field across the parameter sets, which sizes a region. */
export function longest(field: "publicKey" | "secretKey" | "signature"): number {
	return Math.max(...Object.values(parameterSets).map((set) => set[field]));
}
