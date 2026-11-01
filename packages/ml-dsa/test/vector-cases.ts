// Reads the ACVP and Wycheproof vector files into one list of cases. Each
// schema is strict, so a field that a vector update adds fails the read
// instead of slipping past the routing table.

import { Buffer } from "node:buffer";

import { z } from "zod";

import { parameterSets, type ObjectName } from "../src/parameter-sets.js";
import { messageOf } from "./helpers.js";

/** The kind of file that a case comes from. */
export type Suite =
	| "ACVP keyGen"
	| "ACVP sigGen"
	| "ACVP sigGen tr1"
	| "ACVP sigVer"
	| "Wycheproof sign_seed"
	| "Wycheproof sign_noseed"
	| "Wycheproof verify";

/**
 * One vector case. A field that the case doesn't give is `undefined`. For
 * ACVP keyGen, `publicKey` and `secretKey` are the expected outputs, and for
 * ACVP sigGen and Wycheproof signing, `signature` is.
 */
export interface VectorCase {
	readonly suite: Suite;
	/** Names the case by its file, its group, and its case id. */
	readonly label: string;
	readonly objectName: ObjectName;
	/**
	 * What the case expects. Wycheproof gives it, ACVP sigVer gives it as
	 * `testPassed`, and every other ACVP case is valid.
	 */
	readonly result: "valid" | "invalid" | "acceptable";
	/** Wycheproof's flags. ACVP cases have none. */
	readonly flags: readonly string[];
	readonly signatureInterface?: "external" | "internal" | undefined;
	readonly preHash?: "pure" | "preHash" | undefined;
	readonly externalMu?: boolean | undefined;
	readonly deterministic?: boolean | undefined;
	readonly keyFormat?: "seed" | "expanded" | undefined;
	readonly hashAlg?: string | undefined;
	readonly seed?: Uint8Array | undefined;
	readonly secretKey?: Uint8Array | undefined;
	readonly publicKey?: Uint8Array | undefined;
	readonly message?: Uint8Array | undefined;
	/** The message representative, which the vector files call `mu`. */
	readonly messageRepresentative?: Uint8Array | undefined;
	readonly context?: Uint8Array | undefined;
	/** The signing randomness, which the vector files call `rnd`. */
	readonly randomness?: Uint8Array | undefined;
	readonly signature?: Uint8Array | undefined;
}

const hex = z
	.string()
	.regex(/^(?:[0-9a-f]{2})*$/i)
	.transform((text) => Uint8Array.from(Buffer.from(text, "hex")));
const id = z.int().nonnegative();
const parameterSetName = z.enum(["ML-DSA-44", "ML-DSA-65", "ML-DSA-87"]);
const signatureInterface = z.enum(["external", "internal"]);
const preHash = z.enum(["pure", "preHash"]);

function acvpFile<Group extends z.ZodType>(group: Group) {
	return z.strictObject({
		vsId: id,
		algorithm: z.literal("ML-DSA"),
		mode: z.enum(["keyGen", "sigGen", "sigVer"]),
		revision: z.enum(["FIPS204", "FIPS204-tr1"]),
		isSample: z.boolean(),
		testGroups: z.array(group),
	});
}

const KeyGenPrompt = acvpFile(
	z.strictObject({
		tgId: id,
		testType: z.literal("AFT"),
		parameterSet: parameterSetName,
		tests: z.array(z.strictObject({ tcId: id, seed: hex })),
	}),
);
const KeyGenResults = acvpFile(
	z.strictObject({
		tgId: id,
		tests: z.array(z.strictObject({ tcId: id, pk: hex, sk: hex })),
	}),
);
const SigGenPrompt = acvpFile(
	z.strictObject({
		tgId: id,
		testType: z.literal("AFT"),
		parameterSet: parameterSetName,
		deterministic: z.boolean(),
		signatureInterface,
		preHash: preHash.optional(),
		externalMu: z.boolean().optional(),
		keyFormat: z.enum(["seed", "expanded"]).optional(),
		tests: z.array(
			z.strictObject({
				tcId: id,
				seed: hex.optional(),
				sk: hex.optional(),
				message: hex.optional(),
				mu: hex.optional(),
				context: hex.optional(),
				hashAlg: z.string().optional(),
				rnd: hex.optional(),
			}),
		),
	}),
);
const SigGenResults = acvpFile(
	z.strictObject({
		tgId: id,
		tests: z.array(z.strictObject({ tcId: id, signature: hex })),
	}),
);
const SigVerPrompt = acvpFile(
	z.strictObject({
		tgId: id,
		testType: z.literal("AFT"),
		parameterSet: parameterSetName,
		signatureInterface,
		preHash: preHash.optional(),
		externalMu: z.boolean().optional(),
		tests: z.array(
			z.strictObject({
				tcId: id,
				pk: hex,
				message: hex.optional(),
				mu: hex.optional(),
				context: hex.optional(),
				hashAlg: z.string().optional(),
				signature: hex,
			}),
		),
	}),
);
const SigVerResults = acvpFile(
	z.strictObject({
		tgId: id,
		tests: z.array(z.strictObject({ tcId: id, testPassed: z.boolean() })),
	}),
);

const wycheproofResult = z.enum(["valid", "invalid", "acceptable"]);
const wycheproofSource = z.strictObject({ name: z.string(), version: z.string() });

function wycheproofFile<Group extends z.ZodType>(group: Group) {
	return z.strictObject({
		algorithm: parameterSetName,
		schema: z.string(),
		numberOfTests: id,
		header: z.array(z.string()),
		notes: z.record(z.string(), z.unknown()),
		testGroups: z.array(group),
	});
}

const WycheproofSign = wycheproofFile(
	z.strictObject({
		type: z.literal("MlDsaSign"),
		privateSeed: hex.optional(),
		privateKeyPkcs8: hex.optional(),
		privateKey: hex.optional(),
		publicKey: hex.nullable(),
		source: wycheproofSource,
		tests: z.array(
			z.strictObject({
				tcId: id,
				comment: z.string(),
				flags: z.array(z.string()),
				msg: hex.optional(),
				mu: hex.optional(),
				ctx: hex.optional(),
				rnd: hex.optional(),
				sig: hex,
				result: wycheproofResult,
			}),
		),
	}),
);
const WycheproofVerify = wycheproofFile(
	z.strictObject({
		type: z.literal("MlDsaVerify"),
		publicKey: hex,
		publicKeyDer: hex,
		source: wycheproofSource,
		tests: z.array(
			z.strictObject({
				tcId: id,
				comment: z.string(),
				flags: z.array(z.string()),
				msg: hex,
				ctx: hex.optional(),
				sig: hex,
				result: wycheproofResult,
			}),
		),
	}),
);

/** One ACVP folder: the suite of its cases, and the mode and revision that both its files give. */
interface AcvpFolder {
	readonly suite: Suite;
	readonly mode: "keyGen" | "sigGen" | "sigVer";
	readonly revision: "FIPS204" | "FIPS204-tr1";
}

const acvpFolders: ReadonlyMap<string, AcvpFolder> = new Map([
	["ML-DSA-keyGen-FIPS204", { suite: "ACVP keyGen", mode: "keyGen", revision: "FIPS204" }],
	["ML-DSA-sigGen-FIPS204", { suite: "ACVP sigGen", mode: "sigGen", revision: "FIPS204" }],
	[
		"ML-DSA-sigGen-FIPS204-tr1",
		{ suite: "ACVP sigGen tr1", mode: "sigGen", revision: "FIPS204-tr1" },
	],
	["ML-DSA-sigVer-FIPS204", { suite: "ACVP sigVer", mode: "sigVer", revision: "FIPS204" }],
]);

const wycheproofSuites: ReadonlyMap<string, Suite> = new Map([
	["sign_seed", "Wycheproof sign_seed"],
	["sign_noseed", "Wycheproof sign_noseed"],
	["verify", "Wycheproof verify"],
]);

function objectNameOf(name: z.infer<typeof parameterSetName>): ObjectName {
	const objectNames: readonly ObjectName[] = ["mlDsa44", "mlDsa65", "mlDsa87"];
	const objectName = objectNames.find((key) => parameterSets[key].parameterSet === name);
	if (objectName === undefined) {
		throw new Error(`No exported object has the parameter set ${name}.`);
	}
	return objectName;
}

function parse<Schema extends z.ZodType>(
	schema: Schema,
	files: ReadonlyMap<string, Uint8Array>,
	file: string,
): z.infer<Schema> {
	const bytes = files.get(file);
	if (bytes === undefined) {
		throw new Error(`vectors/${file} is missing.`);
	}
	let json: unknown = undefined;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (error) {
		throw new Error(`vectors/${file} isn't valid UTF-8 JSON: ${messageOf(error)}`, {
			cause: error,
		});
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new Error(`vectors/${file} doesn't match its schema:\n${z.prettifyError(parsed.error)}`);
	}
	return parsed.data;
}

interface AcvpGroup<Test> {
	readonly tgId: number;
	readonly tests: readonly Test[];
}

/**
 * Pairs each prompt case with the case of the same group and case id in the
 * expected results.
 *
 * @throws Error if either file lists a case id twice, a case lacks its
 * expected result, or the expected results hold a case that the prompt lacks.
 */
function joinResults<Group extends AcvpGroup<{ readonly tcId: number }>, Result>(
	folderPath: string,
	prompt: readonly Group[],
	results: readonly AcvpGroup<Result & { readonly tcId: number }>[],
): readonly (readonly [Group, Group["tests"][number], Result])[] {
	const expected = new Map<string, Result>();
	for (const group of results) {
		for (const test of group.tests) {
			const key = `${group.tgId}/${test.tcId}`;
			if (expected.has(key)) {
				throw new Error(
					`${folderPath}: expectedResults.json lists tgId ${group.tgId} tcId ${test.tcId} more than once.`,
				);
			}
			expected.set(key, test);
		}
	}
	const joined: (readonly [Group, Group["tests"][number], Result])[] = [];
	const seen = new Set<string>();
	for (const group of prompt) {
		for (const test of group.tests) {
			const key = `${group.tgId}/${test.tcId}`;
			if (seen.has(key)) {
				throw new Error(
					`${folderPath}: prompt.json lists tgId ${group.tgId} tcId ${test.tcId} more than once.`,
				);
			}
			seen.add(key);
			const result = expected.get(key);
			if (result === undefined) {
				throw new Error(
					`${folderPath}: tgId ${group.tgId} tcId ${test.tcId} has no expected result.`,
				);
			}
			expected.delete(key);
			joined.push([group, test, result]);
		}
	}
	if (expected.size > 0) {
		const extra = [...expected.keys()].map((key) => `tgId ${key.replace("/", " tcId ")}`);
		throw new Error(
			`${folderPath}: expectedResults.json has cases that prompt.json lacks: ${extra.join(", ")}.`,
		);
	}
	return joined;
}

interface AcvpHeader {
	readonly vsId: number;
	readonly mode: string;
	readonly revision: string;
	readonly isSample: boolean;
}

/**
 * Checks that both files of an ACVP pair give the mode and revision of their
 * folder, and come from the same vector set.
 */
function checkHeaders(
	folderPath: string,
	acvpFolder: AcvpFolder,
	prompt: AcvpHeader,
	results: AcvpHeader,
): void {
	for (const [file, header] of [
		["prompt.json", prompt],
		["expectedResults.json", results],
	] as const) {
		if (header.mode !== acvpFolder.mode || header.revision !== acvpFolder.revision) {
			throw new Error(
				`${folderPath}/${file} gives mode ${header.mode} and revision ${header.revision}, but its folder holds mode ${acvpFolder.mode} and revision ${acvpFolder.revision}.`,
			);
		}
	}
	if (prompt.vsId !== results.vsId || prompt.isSample !== results.isSample) {
		throw new Error(
			`${folderPath}: prompt.json and expectedResults.json come from different vector sets.`,
		);
	}
}

function acvpCases(
	files: ReadonlyMap<string, Uint8Array>,
	folder: string,
	acvpFolder: AcvpFolder,
): readonly VectorCase[] {
	const { suite } = acvpFolder;
	const promptFile = `acvp/${folder}/prompt.json`;
	const resultsFile = `acvp/${folder}/expectedResults.json`;
	const folderPath = `vectors/acvp/${folder}`;
	const label = (tgId: number, tcId: number): string => `acvp/${folder} tgId ${tgId} tcId ${tcId}`;
	if (suite === "ACVP keyGen") {
		const prompt = parse(KeyGenPrompt, files, promptFile);
		const results = parse(KeyGenResults, files, resultsFile);
		checkHeaders(folderPath, acvpFolder, prompt, results);
		return joinResults(folderPath, prompt.testGroups, results.testGroups).map(
			([group, test, result]) => ({
				suite,
				label: label(group.tgId, test.tcId),
				objectName: objectNameOf(group.parameterSet),
				result: "valid",
				flags: [],
				seed: test.seed,
				publicKey: result.pk,
				secretKey: result.sk,
			}),
		);
	}
	if (suite === "ACVP sigVer") {
		const prompt = parse(SigVerPrompt, files, promptFile);
		const results = parse(SigVerResults, files, resultsFile);
		checkHeaders(folderPath, acvpFolder, prompt, results);
		return joinResults(folderPath, prompt.testGroups, results.testGroups).map(
			([group, test, result]) => ({
				suite,
				label: label(group.tgId, test.tcId),
				objectName: objectNameOf(group.parameterSet),
				result: result.testPassed ? "valid" : "invalid",
				flags: [],
				signatureInterface: group.signatureInterface,
				preHash: group.preHash,
				externalMu: group.externalMu,
				hashAlg: test.hashAlg,
				publicKey: test.pk,
				message: test.message,
				messageRepresentative: test.mu,
				context: test.context,
				signature: test.signature,
			}),
		);
	}
	const prompt = parse(SigGenPrompt, files, promptFile);
	const results = parse(SigGenResults, files, resultsFile);
	checkHeaders(folderPath, acvpFolder, prompt, results);
	return joinResults(folderPath, prompt.testGroups, results.testGroups).map(
		([group, test, result]) => ({
			suite,
			label: label(group.tgId, test.tcId),
			objectName: objectNameOf(group.parameterSet),
			result: "valid",
			flags: [],
			signatureInterface: group.signatureInterface,
			preHash: group.preHash,
			externalMu: group.externalMu,
			deterministic: group.deterministic,
			keyFormat: group.keyFormat,
			hashAlg: test.hashAlg,
			seed: test.seed,
			secretKey: test.sk,
			message: test.message,
			messageRepresentative: test.mu,
			context: test.context,
			randomness: test.rnd,
			signature: result.signature,
		}),
	);
}

function wycheproofCases(
	files: ReadonlyMap<string, Uint8Array>,
	file: string,
	parameterSet: string,
	suite: Suite,
): readonly VectorCase[] {
	const label = (tcId: number): string => `${file} tcId ${tcId}`;
	const cases: VectorCase[] = [];
	const ids = new Set<number>();
	const claimId = (tcId: number): void => {
		if (ids.has(tcId)) {
			throw new Error(`vectors/${file} lists tcId ${tcId} more than once.`);
		}
		ids.add(tcId);
	};
	const checkHeader = (algorithm: string, numberOfTests: number): void => {
		if (algorithm !== parameterSet) {
			throw new Error(`vectors/${file} names the algorithm ${algorithm}, not ${parameterSet}.`);
		}
		if (cases.length !== numberOfTests) {
			throw new Error(
				`vectors/${file} gives numberOfTests as ${numberOfTests}, but its groups hold ${cases.length}.`,
			);
		}
	};
	if (suite === "Wycheproof verify") {
		const contents = parse(WycheproofVerify, files, file);
		const objectName = objectNameOf(contents.algorithm);
		for (const group of contents.testGroups) {
			for (const test of group.tests) {
				claimId(test.tcId);
				cases.push({
					suite,
					label: label(test.tcId),
					objectName,
					result: test.result,
					flags: test.flags,
					publicKey: group.publicKey,
					message: test.msg,
					context: test.ctx,
					signature: test.sig,
				});
			}
		}
		checkHeader(contents.algorithm, contents.numberOfTests);
		return cases;
	}
	const contents = parse(WycheproofSign, files, file);
	const objectName = objectNameOf(contents.algorithm);
	for (const group of contents.testGroups) {
		// A sign_seed file gives a seed in each group, and a sign_noseed file a
		// secret key, so the routing table can key on the suite alone.
		const hasSeed = group.privateSeed !== undefined;
		if (
			hasSeed !== (suite === "Wycheproof sign_seed") ||
			hasSeed === (group.privateKey !== undefined)
		) {
			throw new Error(`vectors/${file}: a group gives the wrong kind of key for ${suite}.`);
		}
		for (const test of group.tests) {
			claimId(test.tcId);
			cases.push({
				suite,
				label: label(test.tcId),
				objectName,
				result: test.result,
				flags: test.flags,
				seed: group.privateSeed,
				secretKey: group.privateKey,
				publicKey: group.publicKey ?? undefined,
				message: test.msg,
				messageRepresentative: test.mu,
				context: test.ctx,
				randomness: test.rnd,
				signature: test.sig,
			});
		}
	}
	checkHeader(contents.algorithm, contents.numberOfTests);
	return cases;
}

/**
 * Reads every case from the vector files.
 *
 * @param files The bytes of each vector file, keyed by its path in the
 * `vectors` folder, as `readVerifiedVectors` returns them.
 * @throws Error if a file has no reader, lacks the other file of its ACVP pair,
 * isn't valid UTF-8 JSON, doesn't match its schema, lists a case id twice, or
 * disagrees with its name, its folder, its header, or the other file of its
 * pair.
 */
export function readCases(files: ReadonlyMap<string, Uint8Array>): readonly VectorCase[] {
	const cases: VectorCase[] = [];
	for (const file of files.keys()) {
		const acvp = /^acvp\/([^/]+)\/(prompt|expectedResults)\.json$/.exec(file);
		const wycheproof =
			/^wycheproof\/mldsa_(44|65|87)_(sign_seed|sign_noseed|verify)_test\.json$/.exec(file);
		const acvpFolder = acvpFolders.get(acvp?.[1] ?? "");
		const wycheproofSuite = wycheproofSuites.get(wycheproof?.[2] ?? "");
		if (acvp !== null && acvpFolder !== undefined) {
			const [, folder = "", kind] = acvp;
			const partner = kind === "prompt" ? "expectedResults.json" : "prompt.json";
			if (!files.has(`acvp/${folder}/${partner}`)) {
				throw new Error(`vectors/${file} has no ${partner} beside it.`);
			}
			// `acvpCases` reads both files of the pair, so only the prompt calls it.
			if (kind === "prompt") {
				cases.push(...acvpCases(files, folder, acvpFolder));
			}
		} else if (wycheproof !== null && wycheproofSuite !== undefined) {
			cases.push(...wycheproofCases(files, file, `ML-DSA-${wycheproof[1] ?? ""}`, wycheproofSuite));
		} else {
			throw new Error(`No reader knows vectors/${file}. Add one to test/vector-cases.ts.`);
		}
	}
	return cases;
}
