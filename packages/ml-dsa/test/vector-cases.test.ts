import { describe, expect, test } from "vite-plus/test";

import { readCases } from "./vector-cases.js";

const encoder = new TextEncoder();

/** Vector files as `readVerifiedVectors` returns them, from JSON values keyed by path. */
function files(entries: Readonly<Record<string, unknown>>): ReadonlyMap<string, Uint8Array> {
	return new Map(
		Object.entries(entries).map(([file, json]) => [file, encoder.encode(JSON.stringify(json))]),
	);
}

const keyGenPath = "acvp/ML-DSA-keyGen-FIPS204";
const acvpHeader = {
	vsId: 1,
	algorithm: "ML-DSA",
	mode: "keyGen",
	revision: "FIPS204",
	isSample: true,
};
const keyGenPrompt = {
	...acvpHeader,
	testGroups: [
		{
			tgId: 1,
			testType: "AFT",
			parameterSet: "ML-DSA-44",
			tests: [{ tcId: 1, seed: "00".repeat(32) }],
		},
	],
};

/** Expected keyGen results for the case ids in `tcIds`, all in group 1. */
function keyGenResults(...tcIds: readonly number[]): Readonly<Record<string, unknown>> {
	return {
		...acvpHeader,
		testGroups: [{ tgId: 1, tests: tcIds.map((tcId) => ({ tcId, pk: "01", sk: "02" })) }],
	};
}

/**
 * A Wycheproof verify file whose header says `numberOfTests`, with one group
 * per id in `tcIds` and one case in each group.
 */
function verifyFile(
	algorithm: string,
	numberOfTests: number,
	tcIds: readonly number[] = [7],
): unknown {
	return {
		algorithm,
		schema: "mldsa_verify_schema.json",
		numberOfTests,
		header: [],
		notes: {},
		testGroups: tcIds.map((tcId) => ({
			type: "MlDsaVerify",
			publicKey: "01",
			publicKeyDer: "02",
			source: { name: "fixture", version: "1" },
			tests: [{ tcId, comment: "", flags: [], msg: "", sig: "03", result: "valid" }],
		})),
	};
}

describe("readCases", () => {
	test("pairs each ACVP prompt case with its expected result", () => {
		const cases = readCases(
			files({
				[`${keyGenPath}/prompt.json`]: keyGenPrompt,
				[`${keyGenPath}/expectedResults.json`]: keyGenResults(1),
			}),
		);
		expect(cases).toStrictEqual([
			{
				suite: "ACVP keyGen",
				label: `${keyGenPath} tgId 1 tcId 1`,
				objectName: "mlDsa44",
				result: "valid",
				flags: [],
				seed: new Uint8Array(32),
				publicKey: Uint8Array.of(1),
				secretKey: Uint8Array.of(2),
			},
		]);
	});

	test("fails on a prompt case with no expected result", () => {
		const vectors = files({
			[`${keyGenPath}/prompt.json`]: keyGenPrompt,
			[`${keyGenPath}/expectedResults.json`]: keyGenResults(),
		});
		expect(() => readCases(vectors)).toThrow(
			`vectors/${keyGenPath}: tgId 1 tcId 1 has no expected result.`,
		);
	});

	test("fails on an expected result that the prompt lacks", () => {
		const vectors = files({
			[`${keyGenPath}/prompt.json`]: keyGenPrompt,
			[`${keyGenPath}/expectedResults.json`]: keyGenResults(1, 2),
		});
		expect(() => readCases(vectors)).toThrow(
			`vectors/${keyGenPath}: expectedResults.json has cases that prompt.json lacks: tgId 1 tcId 2.`,
		);
	});

	test("fails on a case id that either file of the pair lists twice", () => {
		const twicePrompted = {
			...keyGenPrompt,
			testGroups: [
				{
					...keyGenPrompt.testGroups[0],
					tests: [
						{ tcId: 1, seed: "00" },
						{ tcId: 1, seed: "01" },
					],
				},
			],
		};
		expect(() =>
			readCases(
				files({
					[`${keyGenPath}/prompt.json`]: twicePrompted,
					[`${keyGenPath}/expectedResults.json`]: keyGenResults(1),
				}),
			),
		).toThrow(`vectors/${keyGenPath}: prompt.json lists tgId 1 tcId 1 more than once.`);
		expect(() =>
			readCases(
				files({
					[`${keyGenPath}/prompt.json`]: keyGenPrompt,
					[`${keyGenPath}/expectedResults.json`]: keyGenResults(1, 1),
				}),
			),
		).toThrow(`vectors/${keyGenPath}: expectedResults.json lists tgId 1 tcId 1 more than once.`);
	});

	const headerMismatch = (file: string, mode: string, revision: string): string =>
		`vectors/${keyGenPath}/${file} gives mode ${mode} and revision ${revision}, but its folder holds mode keyGen and revision FIPS204.`;
	const otherSet = `vectors/${keyGenPath}: prompt.json and expectedResults.json come from different vector sets.`;

	test.each([
		[
			"the prompt's mode",
			{ mode: "sigVer" },
			{},
			headerMismatch("prompt.json", "sigVer", "FIPS204"),
		],
		[
			"the expected results' mode",
			{},
			{ mode: "sigVer" },
			headerMismatch("expectedResults.json", "sigVer", "FIPS204"),
		],
		[
			"the expected results' revision",
			{},
			{ revision: "FIPS204-tr1" },
			headerMismatch("expectedResults.json", "keyGen", "FIPS204-tr1"),
		],
		["the expected results' vsId", {}, { vsId: 2 }, otherSet],
		["the expected results' isSample", {}, { isSample: false }, otherSet],
	])(
		"fails on a header that disagrees with its folder or its pair: %s",
		(_, prompt, results, message) => {
			const vectors = files({
				[`${keyGenPath}/prompt.json`]: { ...keyGenPrompt, ...prompt },
				[`${keyGenPath}/expectedResults.json`]: { ...keyGenResults(1), ...results },
			});
			expect(() => readCases(vectors)).toThrow(message);
		},
	);

	test("fails on a file that isn't UTF-8 JSON, and names the file", () => {
		const prompt = `${keyGenPath}/prompt.json`;
		const results = { [`${keyGenPath}/expectedResults.json`]: encoder.encode("{}") };
		// A byte that isn't UTF-8 inside a JSON string, which only a fatal decoder
		// rejects.
		for (const bytes of [encoder.encode("{"), Uint8Array.of(0x22, 0xff, 0x22)]) {
			const vectors = new Map(Object.entries({ [prompt]: bytes, ...results }));
			expect(() => readCases(vectors)).toThrow(`vectors/${prompt} isn't valid UTF-8 JSON: `);
		}
	});

	test("fails on a field that the schema doesn't know", () => {
		const group = { ...keyGenPrompt.testGroups[0], comment: "new field" };
		const vectors = files({
			[`${keyGenPath}/prompt.json`]: { ...keyGenPrompt, testGroups: [group] },
			[`${keyGenPath}/expectedResults.json`]: keyGenResults(1),
		});
		expect(() => readCases(vectors)).toThrow(
			`vectors/${keyGenPath}/prompt.json doesn't match its schema:`,
		);
	});

	test("fails on an ACVP file without the other file of its pair", () => {
		const results = files({ [`${keyGenPath}/expectedResults.json`]: keyGenResults(1) });
		expect(() => readCases(results)).toThrow(
			`vectors/${keyGenPath}/expectedResults.json has no prompt.json beside it.`,
		);
		const prompt = files({ [`${keyGenPath}/prompt.json`]: keyGenPrompt });
		expect(() => readCases(prompt)).toThrow(
			`vectors/${keyGenPath}/prompt.json has no expectedResults.json beside it.`,
		);
	});

	test("fails on a file that no reader knows", () => {
		const vectors = files({ [`${keyGenPath}/registration.json`]: {} });
		expect(() => readCases(vectors)).toThrow(
			`No reader knows vectors/${keyGenPath}/registration.json. Add one to test/vector-cases.ts.`,
		);
	});

	test("fails on a Wycheproof file that lists a case id twice, across its groups", () => {
		const file = "wycheproof/mldsa_44_verify_test.json";
		expect(() => readCases(files({ [file]: verifyFile("ML-DSA-44", 2, [7, 7]) }))).toThrow(
			`vectors/${file} lists tcId 7 more than once.`,
		);
	});

	test("fails on a Wycheproof file whose header disagrees with its cases or its name", () => {
		const file = "wycheproof/mldsa_44_verify_test.json";
		expect(() => readCases(files({ [file]: verifyFile("ML-DSA-44", 2) }))).toThrow(
			`vectors/${file} gives numberOfTests as 2, but its groups hold 1.`,
		);
		expect(() => readCases(files({ [file]: verifyFile("ML-DSA-65", 1) }))).toThrow(
			`vectors/${file} names the algorithm ML-DSA-65, not ML-DSA-44.`,
		);
	});

	test.each([
		["a secret key in place of a seed", { privateKey: "01" }],
		["both a seed and a secret key", { privateSeed: "01", privateKey: "02" }],
	])("fails on a sign_seed group that gives %s", (_, keys) => {
		const file = "wycheproof/mldsa_44_sign_seed_test.json";
		const signFile = {
			algorithm: "ML-DSA-44",
			schema: "mldsa_sign_seed_schema.json",
			numberOfTests: 0,
			header: [],
			notes: {},
			testGroups: [
				{
					type: "MlDsaSign",
					...keys,
					publicKey: "03",
					source: { name: "fixture", version: "1" },
					tests: [],
				},
			],
		};
		expect(() => readCases(files({ [file]: signFile }))).toThrow(
			`vectors/${file}: a group gives the wrong kind of key for Wycheproof sign_seed.`,
		);
	});
});
