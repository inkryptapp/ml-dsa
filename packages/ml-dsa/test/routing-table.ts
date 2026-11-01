// The routing table sends each vector case through the narrowest path that
// produces the case's expected output: the public API when it can express
// the case, the test-only entry point when it can't, or no path for the
// HashML-DSA cases and the Wycheproof sign_noseed cases with a bad secret
// key. Each row is a predicate over the file, the group, the input fields,
// and the flags, and every case must match exactly one row.

import sizes from "../wasm/sizes.json" with { type: "json" };
import { mlDsa44, mlDsa65, mlDsa87 } from "../src/index.js";
import { maxContextBytes, parameterSets, seedBytes } from "../src/parameter-sets.js";
import {
	keyPair,
	signExternalMu,
	signFromSecretKey,
	signInternal,
	verifyExternalMu,
	verifyInternal,
} from "../src/testing.js";
import { firstDifference, isAllZero, messageOf, prototypeOf } from "./helpers.js";
import { noCases, type SegmentCount, type SegmentName } from "./segment-table.js";
import type { VectorCase } from "./vector-cases.js";

/**
 * The routing table's version. Raise it when a row is added or removed, or
 * when a row's predicate or path changes.
 */
export const routingTableVersion = 1;

/** Every path that a row can send its cases through, in the order that the vector test prints them. */
export const paths = [
	"public keygen",
	"public sign",
	"public verify",
	"test-only",
	"not run",
] as const;

/** The path that a row sends its cases through. */
export type Path = (typeof paths)[number];

/** One row of the routing table. */
export interface Row {
	readonly name: string;
	readonly path: Path;
	/**
	 * How many cases the row gets. A vector update changes it in the same
	 * commit as the files and the manifest.
	 */
	readonly cases: number;
	readonly matches: (vector: VectorCase) => boolean;
	/**
	 * Runs one case, and throws if the call's result differs from what the
	 * case's `result` asks for. A row whose path is `not run` has none.
	 */
	readonly run?: (vector: VectorCase) => void;
	/**
	 * Whether `run` decides a case whose `result` is `acceptable`. Without it,
	 * such a case fails routing.
	 */
	readonly handlesAcceptable?: true;
	/** The segments that the row's path runs for one case. */
	readonly segments: (vector: VectorCase) => readonly SegmentName[];
}

const objects = { mlDsa44, mlDsa65, mlDsa87 };

type ByteField =
	| "seed"
	| "secretKey"
	| "publicKey"
	| "message"
	| "messageRepresentative"
	| "context"
	| "randomness"
	| "signature";

/**
 * A byte field that the row's predicate or the shape rules guarantee.
 *
 * @throws Error if the case lacks it after all.
 */
function field(vector: VectorCase, key: ByteField): Uint8Array {
	const value = vector[key];
	if (value === undefined) {
		throw new Error(`The case gives no ${key}.`);
	}
	return value;
}

/** Whether the public API accepts the case's seed: 32 bytes, not all zero. */
function hasPublicSeed(vector: VectorCase): boolean {
	return vector.seed !== undefined && vector.seed.length === seedBytes && !isAllZero(vector.seed);
}

function hasZeroSeed(vector: VectorCase): boolean {
	return vector.seed !== undefined && vector.seed.length === seedBytes && isAllZero(vector.seed);
}

function hasZeroRandomness(vector: VectorCase): boolean {
	return vector.randomness !== undefined && isAllZero(vector.randomness);
}

function fitsContext(vector: VectorCase): boolean {
	return vector.context === undefined || vector.context.length <= maxContextBytes;
}

function randomnessOf(vector: VectorCase): Uint8Array | "deterministic" {
	return vector.randomness ?? "deterministic";
}

function hasFlag(vector: VectorCase, flag: string): boolean {
	return vector.flags.includes(flag);
}

/**
 * An ACVP signing case that gives a secret key: every sigGen case, and the
 * tr1 `expanded` cases.
 */
function signsFromAcvpSecretKey(vector: VectorCase): boolean {
	return (
		vector.suite === "ACVP sigGen" ||
		(vector.suite === "ACVP sigGen tr1" && vector.keyFormat === "expanded")
	);
}

function signsFromAcvpSeed(vector: VectorCase): boolean {
	return vector.suite === "ACVP sigGen tr1" && vector.keyFormat === "seed";
}

/** An ACVP case of `ML-DSA.Sign` or `ML-DSA.Verify` with pure ML-DSA. */
function isPure(vector: VectorCase): boolean {
	return vector.signatureInterface === "external" && vector.preHash === "pure";
}

/** An ACVP case of `ML-DSA.Sign_internal` or `ML-DSA.Verify_internal` on a message. */
function isInternal(vector: VectorCase): boolean {
	return vector.signatureInterface === "internal" && vector.externalMu !== true;
}

function isExternalMu(vector: VectorCase): boolean {
	return vector.signatureInterface === "internal" && vector.externalMu === true;
}

/**
 * Whether a Wycheproof sign_noseed case gives a secret key that the package
 * never imports.
 */
function givesUnimportedKey(vector: VectorCase): boolean {
	return hasFlag(vector, "InvalidPrivateKey") || hasFlag(vector, "IncorrectPrivateKeyLength");
}

function expectBytes(what: string, actual: Uint8Array, expected: Uint8Array): void {
	const offset = firstDifference(actual, expected);
	if (offset !== null) {
		throw new Error(`The ${what} differs from the case's at byte ${offset}.`);
	}
}

/** Expects `action` to throw a `RangeError`, as an input check does. */
function expectRangeError(what: string, action: () => unknown): void {
	try {
		action();
	} catch (error) {
		if (prototypeOf(error) === RangeError.prototype) {
			return;
		}
		throw new Error(`${what} threw "${messageOf(error)}", but the case expects a RangeError.`, {
			cause: error,
		});
	}
	throw new Error(`${what} returned, but the case expects a RangeError.`);
}

/**
 * For a valid case, expects `sign` to give the case's signature, and for an
 * invalid one, a `RangeError`.
 */
function expectSignature(vector: VectorCase, what: string, sign: () => Uint8Array): void {
	if (vector.result === "valid") {
		expectBytes(`signature from ${what}`, sign(), field(vector, "signature"));
	} else if (vector.result === "invalid") {
		expectRangeError(what, sign);
	} else {
		throw new Error(`No assertion decides a case whose result is ${vector.result}.`);
	}
}

/**
 * Runs a test-only verification and returns its verdict. The test-only
 * entry point throws a `RangeError` for a wrong length where the public
 * `verify` returns `false`, so for an invalid case the error counts as
 * `false`. Any other error, and any error for a valid case, propagates.
 */
function testOnlyVerdict(vector: VectorCase, verify: () => boolean): boolean {
	try {
		return verify();
	} catch (error) {
		if (vector.result === "invalid" && prototypeOf(error) === RangeError.prototype) {
			return false;
		}
		throw error;
	}
}

/** Expects `verify` to return `true` for a valid case and `false` for an invalid one. */
function expectVerdict(vector: VectorCase, what: string, verify: () => boolean): void {
	if (vector.result === "acceptable") {
		throw new Error(`No assertion decides a case whose result is ${vector.result}.`);
	}
	const verdict = verify();
	if (verdict !== (vector.result === "valid")) {
		throw new Error(`${what} returned ${String(verdict)}, but the case is ${vector.result}.`);
	}
}

function messageSegment(message: Uint8Array): SegmentName {
	if (message.length === 0) {
		return "empty message";
	}
	return message.length <= sizes.chunkBytes ? "one-chunk message" : "multi-chunk message";
}

function contextSegment(vector: VectorCase): SegmentName {
	return vector.context === undefined || vector.context.length === 0
		? "prefix with an empty context"
		: "prefix with a non-empty context";
}

function signingSegment(vector: VectorCase): SegmentName {
	return vector.randomness === undefined || isAllZero(vector.randomness)
		? "deterministic variant"
		: "hedged signing";
}

/** How a call frames what it signs or verifies. */
type Framing = "pure" | "internal" | "external mu";

/** The segments that write the message representative for one framing. */
function representativeSegments(
	vector: VectorCase,
	framing: Framing,
	publicKeyHash: SegmentName,
): readonly SegmentName[] {
	if (framing === "external mu") {
		return ["external mu"];
	}
	const prefix = framing === "pure" ? contextSegment(vector) : "message with no prefix";
	return [publicKeyHash, prefix, messageSegment(field(vector, "message"))];
}

const keygenSegments: readonly SegmentName[] = [
	"input checks",
	"zero checks",
	"key pair from the seed",
	"output and wipe",
];

function publicSignSegments(vector: VectorCase): readonly SegmentName[] {
	if (vector.result !== "valid") {
		return ["input checks"];
	}
	return [
		...keygenSegments,
		...representativeSegments(vector, "pure", "public-key hash from the secret key"),
		signingSegment(vector),
	];
}

/**
 * The segments of a test-only signing call from a secret key, which a row
 * either takes from the case or derives from the case's seed first.
 */
function testOnlySignSegments(
	vector: VectorCase,
	framing: Framing,
	key: "from the case" | "from the seed",
): readonly SegmentName[] {
	if (vector.result !== "valid") {
		return ["input checks"];
	}
	return [
		"input checks",
		...(key === "from the seed" ? ["key pair from the seed" as const] : []),
		"secret key from the caller",
		...representativeSegments(vector, framing, "public-key hash from the secret key"),
		signingSegment(vector),
		"output and wipe",
	];
}

function verifySegments(vector: VectorCase, framing: Framing): readonly SegmentName[] {
	const set = parameterSets[vector.objectName];
	if (
		field(vector, "publicKey").length !== set.publicKey ||
		field(vector, "signature").length !== set.signature ||
		!fitsContext(vector)
	) {
		return ["input checks"];
	}
	return [
		"input checks",
		...representativeSegments(vector, framing, "public-key hash from the public key"),
		"verification",
		"output and wipe",
	];
}

/** Signs the case's message through the public `sign`, from the case's seed. */
function publicSign(vector: VectorCase, randomness: Uint8Array | "deterministic"): Uint8Array {
	return objects[vector.objectName].sign({
		seed: field(vector, "seed"),
		message: field(vector, "message"),
		context: vector.context,
		randomness,
	});
}

/** Checks the case's signature through the public `verify`, under the case's context string. */
function publicVerify(vector: VectorCase): boolean {
	return objects[vector.objectName].verify({
		publicKey: field(vector, "publicKey"),
		message: field(vector, "message"),
		signature: field(vector, "signature"),
		context: vector.context,
	});
}

/**
 * Expects the public `keygen` to give the case's public key, or a
 * `RangeError` for a seed that it refuses.
 */
function expectPublicKey(vector: VectorCase): void {
	const keygen = (): Uint8Array =>
		objects[vector.objectName].keygen(field(vector, "seed")).publicKey;
	if (hasPublicSeed(vector)) {
		expectBytes("public key from keygen", keygen(), field(vector, "publicKey"));
	} else {
		expectRangeError("keygen", keygen);
	}
}

/**
 * The secret key that the test-only entry point derives from the case's
 * seed. It also checks the derived public key against the case's public key,
 * if the case gives one.
 */
function secretKeyFromSeed(vector: VectorCase): Uint8Array {
	const pair = keyPair(vector.objectName, field(vector, "seed"));
	if (vector.publicKey !== undefined) {
		expectBytes("public key from the test-only keyPair", pair.publicKey, vector.publicKey);
	}
	return pair.secretKey;
}

/** Every row, in the order that the vector test prints them. */
export const routingTable: readonly Row[] = [
	{
		name: "ACVP keyGen",
		path: "public keygen",
		cases: 75,
		matches: (vector) => vector.suite === "ACVP keyGen" && hasPublicSeed(vector),
		run: (vector) => {
			expectPublicKey(vector);
			expectBytes(
				"secret key from the test-only keyPair",
				secretKeyFromSeed(vector),
				field(vector, "secretKey"),
			);
		},
		segments: () => keygenSegments,
	},
	{
		name: "ACVP sigGen tr1 from a seed, pure",
		path: "public sign",
		cases: 90,
		matches: (vector) =>
			signsFromAcvpSeed(vector) &&
			isPure(vector) &&
			hasPublicSeed(vector) &&
			!hasZeroRandomness(vector),
		run: (vector) => {
			expectSignature(vector, "sign", () => publicSign(vector, randomnessOf(vector)));
		},
		segments: publicSignSegments,
	},
	{
		name: "Pure signing with all-zero signing randomness",
		path: "public sign",
		cases: 0,
		matches: (vector) =>
			((signsFromAcvpSeed(vector) && isPure(vector)) ||
				(vector.suite === "Wycheproof sign_seed" && vector.message !== undefined)) &&
			hasPublicSeed(vector) &&
			fitsContext(vector) &&
			hasZeroRandomness(vector),
		run: (vector) => {
			const randomness = field(vector, "randomness");
			expectRangeError("sign with 32 zero bytes of randomness", () =>
				publicSign(vector, randomness),
			);
			expectSignature(vector, "sign", () => publicSign(vector, "deterministic"));
		},
		segments: publicSignSegments,
	},
	{
		name: "ACVP sigGen tr1 from a seed, internal",
		path: "test-only",
		cases: 90,
		matches: (vector) => signsFromAcvpSeed(vector) && isInternal(vector),
		run: (vector) => {
			const secretKey = secretKeyFromSeed(vector);
			expectSignature(vector, "signInternal", () =>
				signInternal(vector.objectName, {
					secretKey,
					message: field(vector, "message"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "internal", "from the seed"),
	},
	{
		name: "ACVP sigGen tr1 from a seed, external mu",
		path: "test-only",
		cases: 90,
		matches: (vector) => signsFromAcvpSeed(vector) && isExternalMu(vector),
		run: (vector) => {
			const secretKey = secretKeyFromSeed(vector);
			expectSignature(vector, "signExternalMu", () =>
				signExternalMu(vector.objectName, {
					secretKey,
					messageRepresentative: field(vector, "messageRepresentative"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "external mu", "from the seed"),
	},
	{
		name: "ACVP sigGen from a secret key, pure",
		path: "test-only",
		cases: 180,
		matches: (vector) => signsFromAcvpSecretKey(vector) && isPure(vector),
		run: (vector) => {
			expectSignature(vector, "signFromSecretKey", () =>
				signFromSecretKey(vector.objectName, {
					secretKey: field(vector, "secretKey"),
					message: field(vector, "message"),
					context: vector.context,
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "pure", "from the case"),
	},
	{
		name: "ACVP sigGen from a secret key, internal",
		path: "test-only",
		cases: 180,
		matches: (vector) => signsFromAcvpSecretKey(vector) && isInternal(vector),
		run: (vector) => {
			expectSignature(vector, "signInternal", () =>
				signInternal(vector.objectName, {
					secretKey: field(vector, "secretKey"),
					message: field(vector, "message"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "internal", "from the case"),
	},
	{
		name: "ACVP sigGen from a secret key, external mu",
		path: "test-only",
		cases: 180,
		matches: (vector) => signsFromAcvpSecretKey(vector) && isExternalMu(vector),
		run: (vector) => {
			expectSignature(vector, "signExternalMu", () =>
				signExternalMu(vector.objectName, {
					secretKey: field(vector, "secretKey"),
					messageRepresentative: field(vector, "messageRepresentative"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "external mu", "from the case"),
	},
	{
		name: "ACVP sigVer, pure",
		path: "public verify",
		cases: 45,
		matches: (vector) => vector.suite === "ACVP sigVer" && isPure(vector),
		run: (vector) => {
			expectVerdict(vector, "verify", () => publicVerify(vector));
		},
		segments: (vector) => verifySegments(vector, "pure"),
	},
	{
		name: "ACVP sigVer, internal",
		path: "test-only",
		cases: 45,
		matches: (vector) => vector.suite === "ACVP sigVer" && isInternal(vector),
		run: (vector) => {
			expectVerdict(vector, "verifyInternal", () =>
				testOnlyVerdict(vector, () =>
					verifyInternal(vector.objectName, {
						publicKey: field(vector, "publicKey"),
						message: field(vector, "message"),
						signature: field(vector, "signature"),
					}),
				),
			);
		},
		segments: (vector) => verifySegments(vector, "internal"),
	},
	{
		name: "ACVP sigVer, external mu",
		path: "test-only",
		cases: 45,
		matches: (vector) => vector.suite === "ACVP sigVer" && isExternalMu(vector),
		run: (vector) => {
			expectVerdict(vector, "verifyExternalMu", () =>
				testOnlyVerdict(vector, () =>
					verifyExternalMu(vector.objectName, {
						publicKey: field(vector, "publicKey"),
						messageRepresentative: field(vector, "messageRepresentative"),
						signature: field(vector, "signature"),
					}),
				),
			);
		},
		segments: (vector) => verifySegments(vector, "external mu"),
	},
	{
		// The package has no HashML-DSA.
		name: "ACVP HashML-DSA",
		path: "not run",
		cases: 315,
		matches: (vector) => vector.preHash === "preHash",
		segments: () => [],
	},
	{
		name: "Wycheproof sign_seed with a message",
		path: "public sign",
		cases: 203,
		matches: (vector) =>
			vector.suite === "Wycheproof sign_seed" &&
			vector.message !== undefined &&
			hasPublicSeed(vector) &&
			fitsContext(vector) &&
			!hasZeroRandomness(vector),
		run: (vector) => {
			expectPublicKey(vector);
			expectSignature(vector, "sign", () => publicSign(vector, randomnessOf(vector)));
		},
		segments: publicSignSegments,
	},
	{
		name: "Wycheproof sign_seed with a seed of the wrong length or a long context",
		path: "public sign",
		cases: 12,
		matches: (vector) =>
			vector.suite === "Wycheproof sign_seed" &&
			vector.message !== undefined &&
			(vector.seed?.length !== seedBytes || !fitsContext(vector)),
		run: (vector) => {
			expectPublicKey(vector);
			expectSignature(vector, "sign", () => publicSign(vector, randomnessOf(vector)));
		},
		segments: (vector) => [
			...(hasPublicSeed(vector) ? keygenSegments : ["input checks" as const]),
			...publicSignSegments(vector),
		],
	},
	{
		// The public API refuses the all-zero seed, so the signature comes from
		// the test-only entry point, and the public API must refuse the seed and
		// accept the signature.
		name: "Wycheproof sign_seed with the all-zero seed",
		path: "test-only",
		cases: 30,
		matches: (vector) =>
			vector.suite === "Wycheproof sign_seed" &&
			vector.message !== undefined &&
			hasZeroSeed(vector) &&
			fitsContext(vector),
		run: (vector) => {
			const secretKey = secretKeyFromSeed(vector);
			expectPublicKey(vector);
			expectRangeError("sign", () => publicSign(vector, randomnessOf(vector)));
			expectSignature(vector, "signFromSecretKey", () =>
				signFromSecretKey(vector.objectName, {
					secretKey,
					message: field(vector, "message"),
					context: vector.context,
					randomness: randomnessOf(vector),
				}),
			);
			if (vector.result === "valid") {
				expectVerdict(vector, "verify", () => publicVerify(vector));
			}
		},
		segments: (vector) => [
			"zero checks",
			...testOnlySignSegments(vector, "pure", "from the seed"),
			...(vector.result === "valid" ? verifySegments(vector, "pure") : []),
		],
	},
	{
		name: "Wycheproof sign_seed with a message representative",
		path: "test-only",
		cases: 42,
		matches: (vector) => vector.suite === "Wycheproof sign_seed" && vector.message === undefined,
		run: (vector) => {
			const secretKey = secretKeyFromSeed(vector);
			expectSignature(vector, "signExternalMu", () =>
				signExternalMu(vector.objectName, {
					secretKey,
					messageRepresentative: field(vector, "messageRepresentative"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "external mu", "from the seed"),
	},
	{
		name: "Wycheproof sign_noseed with a message",
		path: "test-only",
		cases: 181,
		matches: (vector) =>
			vector.suite === "Wycheproof sign_noseed" &&
			!givesUnimportedKey(vector) &&
			vector.message !== undefined,
		run: (vector) => {
			expectSignature(vector, "signFromSecretKey", () =>
				signFromSecretKey(vector.objectName, {
					secretKey: field(vector, "secretKey"),
					message: field(vector, "message"),
					context: vector.context,
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "pure", "from the case"),
	},
	{
		name: "Wycheproof sign_noseed with a message representative",
		path: "test-only",
		cases: 27,
		matches: (vector) =>
			vector.suite === "Wycheproof sign_noseed" &&
			!givesUnimportedKey(vector) &&
			vector.message === undefined,
		run: (vector) => {
			expectSignature(vector, "signExternalMu", () =>
				signExternalMu(vector.objectName, {
					secretKey: field(vector, "secretKey"),
					messageRepresentative: field(vector, "messageRepresentative"),
					randomness: randomnessOf(vector),
				}),
			);
		},
		segments: (vector) => testOnlySignSegments(vector, "external mu", "from the case"),
	},
	{
		// The package never imports a secret key, so it never sees one that is
		// out of range or of the wrong length.
		name: "Wycheproof sign_noseed with a bad secret key",
		path: "not run",
		cases: 12,
		matches: (vector) => vector.suite === "Wycheproof sign_noseed" && givesUnimportedKey(vector),
		segments: () => [],
	},
	{
		name: "Wycheproof verify",
		path: "public verify",
		cases: 631,
		matches: (vector) => vector.suite === "Wycheproof verify",
		run: (vector) => {
			expectVerdict(vector, "verify", () => publicVerify(vector));
		},
		segments: (vector) => verifySegments(vector, "pure"),
	},
];

/** A field shape that a flag, a group property, or the file's format implies. */
interface ShapeRule {
	readonly name: string;
	readonly applies: (vector: VectorCase) => boolean;
	readonly holds: (vector: VectorCase) => boolean;
}

function isWycheproofSigning(vector: VectorCase): boolean {
	return vector.suite === "Wycheproof sign_seed" || vector.suite === "Wycheproof sign_noseed";
}

function isAcvpSigning(vector: VectorCase): boolean {
	return vector.suite === "ACVP sigGen" || vector.suite === "ACVP sigGen tr1";
}

function hasAcvpInterface(vector: VectorCase): boolean {
	return vector.signatureInterface !== undefined;
}

function hasMuOnly(vector: VectorCase): boolean {
	return vector.messageRepresentative !== undefined && vector.message === undefined;
}

const shapeRules: readonly ShapeRule[] = [
	{
		name: "Internal means a message representative and no message",
		applies: isWycheproofSigning,
		holds: (vector) => hasFlag(vector, "Internal") === hasMuOnly(vector),
	},
	{
		name: "Randomized means signing randomness",
		applies: isWycheproofSigning,
		holds: (vector) => hasFlag(vector, "Randomized") === (vector.randomness !== undefined),
	},
	{
		name: "InvalidContext means a context longer than 255 bytes",
		applies: (vector) => hasFlag(vector, "InvalidContext"),
		holds: (vector) => !fitsContext(vector),
	},
	{
		name: "IncorrectPrivateKeyLength means a seed or secret key of the wrong length",
		applies: (vector) => hasFlag(vector, "IncorrectPrivateKeyLength"),
		holds: (vector) =>
			(vector.seed !== undefined && vector.seed.length !== seedBytes) ||
			(vector.secretKey !== undefined &&
				vector.secretKey.length !== parameterSets[vector.objectName].secretKey),
	},
	{
		name: "IncorrectPublicKeyLength means a public key of the wrong length",
		applies: (vector) => hasFlag(vector, "IncorrectPublicKeyLength"),
		holds: (vector) => vector.publicKey?.length !== parameterSets[vector.objectName].publicKey,
	},
	{
		name: "IncorrectSignatureLength means a signature of the wrong length",
		applies: (vector) => hasFlag(vector, "IncorrectSignatureLength"),
		holds: (vector) => vector.signature?.length !== parameterSets[vector.objectName].signature,
	},
	{
		name: "an ACVP signing or verification case gives exactly one of a message and a message representative",
		applies: hasAcvpInterface,
		holds: (vector) =>
			(vector.message !== undefined) !== (vector.messageRepresentative !== undefined),
	},
	{
		name: "externalMu means a message representative and no message",
		applies: hasAcvpInterface,
		holds: (vector) => (vector.externalMu === true) === hasMuOnly(vector),
	},
	{
		name: "the external interface means a context string",
		applies: hasAcvpInterface,
		holds: (vector) =>
			(vector.signatureInterface === "external") === (vector.context !== undefined),
	},
	{
		name: "preHash means a hash function",
		applies: hasAcvpInterface,
		holds: (vector) => (vector.preHash === "preHash") === (vector.hashAlg !== undefined),
	},
	{
		name: "deterministic means no signing randomness",
		applies: isAcvpSigning,
		holds: (vector) => vector.deterministic === (vector.randomness === undefined),
	},
	{
		name: "keyFormat seed means a seed, and any other key format a secret key",
		applies: isAcvpSigning,
		holds: (vector) =>
			(vector.keyFormat === "seed") === (vector.seed !== undefined) &&
			(vector.seed === undefined) === (vector.secretKey !== undefined),
	},
];

/** One message per case and shape rule that the case breaks. */
export function shapeFailures(cases: readonly VectorCase[]): readonly string[] {
	return cases.flatMap((vector) =>
		shapeRules
			.filter((rule) => rule.applies(vector) && !rule.holds(vector))
			.map((rule) => `${vector.label} breaks the shape rule "${rule.name}".`),
	);
}

/** Which row each case goes to, and one message per case that goes to none. */
export interface Routing {
	readonly cases: ReadonlyMap<Row, readonly VectorCase[]>;
	readonly failures: readonly string[];
}

/**
 * Sends each case to the one row of `rows` that matches it. A case that
 * matches no row or several rows goes to no row, and so does a case whose
 * result is `acceptable` unless its row handles that result.
 */
export function route(cases: readonly VectorCase[], rows: readonly Row[]): Routing {
	const routed = new Map<Row, VectorCase[]>(rows.map((row) => [row, []]));
	const failures: string[] = [];
	for (const vector of cases) {
		const matching = rows.filter((row) => row.matches(vector));
		const [row] = matching;
		if (matching.length > 1) {
			failures.push(
				`${vector.label} matches several rows: ${matching.map(({ name }) => name).join(", ")}.`,
			);
		} else if (row === undefined) {
			failures.push(`${vector.label} matches no row of the routing table.`);
		} else if (vector.result === "acceptable" && row.handlesAcceptable !== true) {
			failures.push(
				`${vector.label} has the result "acceptable", which its row "${row.name}" doesn't handle. Give the row an assertion for it and set handlesAcceptable.`,
			);
		} else {
			routed.get(row)?.push(vector);
		}
	}
	return { cases: routed, failures };
}

/** One message per row whose number of cases differs from its pinned count. */
export function countFailures(routing: Routing): readonly string[] {
	return [...routing.cases].flatMap(([row, cases]) =>
		cases.length === row.cases
			? []
			: [`The row "${row.name}" got ${cases.length} cases, but its pinned count is ${row.cases}.`],
	);
}

/**
 * The number of cases that each segment gets, through public rows and
 * through test-only rows. A case counts once per segment, however many times
 * its row credits the segment.
 */
export function segmentCounts(routing: Routing): ReadonlyMap<SegmentName, SegmentCount> {
	const counts = new Map<SegmentName, SegmentCount>();
	for (const [row, cases] of routing.cases) {
		for (const vector of cases) {
			for (const name of new Set(row.segments(vector))) {
				const { publicRows, testOnlyRows } = counts.get(name) ?? noCases;
				counts.set(
					name,
					row.path === "test-only"
						? { publicRows, testOnlyRows: testOnlyRows + 1 }
						: { publicRows: publicRows + 1, testOnlyRows },
				);
			}
		}
	}
	return counts;
}
