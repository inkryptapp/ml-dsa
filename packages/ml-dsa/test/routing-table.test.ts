import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { describe, expect, test } from "vite-plus/test";

import { byteSource, seedFrom } from "./helpers.js";
import {
	countFailures,
	route,
	routingTable,
	segmentCounts,
	shapeFailures,
	type Row,
} from "./routing-table.js";
import { noCases, segmentFailures, type Segment } from "./segment-table.js";
import type { VectorCase } from "./vector-cases.js";

/** A Wycheproof verify case for ML-DSA-44 with no byte fields, and `fields` on top. */
function fixture(fields: Partial<VectorCase> = {}): VectorCase {
	return {
		suite: "Wycheproof verify",
		label: "fixture tcId 1",
		objectName: "mlDsa44",
		result: "valid",
		flags: [],
		...fields,
	};
}

/** The `run` of the routing table's row named `name`. */
function runOf(name: string): Row["run"] {
	return routingTable.find((candidate) => candidate.name === name)?.run;
}

/** A row that matches every case and credits no segment, with `fields` on top. */
function row(name: string, fields: Partial<Row> = {}): Row {
	return {
		name,
		path: "public verify",
		cases: 0,
		matches: () => true,
		segments: () => [],
		...fields,
	};
}

describe("route", () => {
	test("sends a case that no row matches to no row, and says so", () => {
		const unmatched = fixture({ suite: "ACVP keyGen", seed: new Uint8Array(32) });
		const routing = route([unmatched], routingTable);
		expect(routing.failures).toStrictEqual(["fixture tcId 1 matches no row of the routing table."]);
		expect([...routing.cases.values()].flat()).toStrictEqual([]);
	});

	test("sends a case that several rows match to no row, and names the rows", () => {
		const first = row("first");
		const second = row("second");
		const routing = route([fixture()], [first, second]);
		expect(routing.failures).toStrictEqual(["fixture tcId 1 matches several rows: first, second."]);
		expect(routing.cases.get(first)).toStrictEqual([]);
	});

	test("refuses an acceptable result until its row handles that result", () => {
		const acceptable = fixture({ result: "acceptable" });
		expect(route([acceptable], routingTable).failures).toStrictEqual([
			'fixture tcId 1 has the result "acceptable", which its row "Wycheproof verify" doesn\'t handle. Give the row an assertion for it and set handlesAcceptable.',
		]);
		const handling = row("handling", { handlesAcceptable: true });
		const routing = route([acceptable], [handling]);
		expect(routing.failures).toStrictEqual([]);
		expect(routing.cases.get(handling)).toStrictEqual([acceptable]);
	});
});

describe("the row for all-zero signing randomness", () => {
	const zeroRow = routingTable.find(
		({ name }) => name === "Pure signing with all-zero signing randomness",
	);
	const seed = seedFrom(70);
	const message = byteSource(0x5eed_0070)(64);
	const { publicKey, secretKey } = ml_dsa44.keygen(seed);
	const zeroRandomness = fixture({
		suite: "Wycheproof sign_seed",
		flags: ["Randomized"],
		seed,
		publicKey,
		message,
		randomness: new Uint8Array(32),
		signature: ml_dsa44.sign(message, secretKey, { extraEntropy: false }),
	});

	test("gets a sign_seed case whose signing randomness is all zeros", () => {
		const routing = route([zeroRandomness], routingTable);
		expect(routing.failures).toStrictEqual([]);
		expect(zeroRow === undefined ? undefined : routing.cases.get(zeroRow)).toStrictEqual([
			zeroRandomness,
		]);
	});

	test("signs the case through the public sign with deterministic, and checks the signature", () => {
		const run = zeroRow?.run;
		expect(run).toBeTypeOf("function");
		expect(() => run?.(zeroRandomness)).not.toThrow();
		const signature = zeroRandomness.signature?.slice() ?? new Uint8Array(0);
		signature[0] = (signature[0] ?? 0) ^ 1;
		expect(() => run?.({ ...zeroRandomness, signature })).toThrow(
			"The signature from sign differs from the case's at byte 0.",
		);
	});
});

describe("the test-only sigVer rows", () => {
	test.each([
		["ACVP sigVer, internal", { message: new Uint8Array(1) }],
		["ACVP sigVer, external mu", { externalMu: true, messageRepresentative: new Uint8Array(64) }],
	])("decide a public key of the wrong length by the case's result, in %s", (name, fields) => {
		const run = runOf(name);
		const shortKey = fixture({
			suite: "ACVP sigVer",
			result: "invalid",
			signatureInterface: "internal",
			publicKey: new Uint8Array(1311),
			signature: new Uint8Array(2420),
			...fields,
		});
		expect(run).toBeTypeOf("function");
		expect(() => run?.(shortKey)).not.toThrow();
		expect(() => run?.({ ...shortKey, result: "valid" })).toThrow(
			"mlDsa44.verify: publicKey must be 1312 bytes long.",
		);
	});

	test.each([
		["ACVP sigVer, internal", "message", {}],
		["ACVP sigVer, external mu", "messageRepresentative", { externalMu: true }],
	])(
		"let an error other than a RangeError through, even for an invalid case, in %s",
		(name, missing, fields) => {
			const run = runOf(name);
			const incomplete = fixture({
				suite: "ACVP sigVer",
				result: "invalid",
				signatureInterface: "internal",
				publicKey: new Uint8Array(1312),
				signature: new Uint8Array(2420),
				...fields,
			});
			expect(() => run?.(incomplete)).toThrow(`The case gives no ${missing}.`);
		},
	);
});

describe("the rows' assertions", () => {
	const seed = seedFrom(71);
	const message = byteSource(0x5eed_0071)(32);
	const { publicKey, secretKey } = ml_dsa44.keygen(seed);
	const signature = ml_dsa44.sign(message, secretKey, { extraEntropy: false });

	test("fail an invalid case whose signature verifies", () => {
		const run = runOf("Wycheproof verify");
		const verifies = fixture({ result: "invalid", publicKey, message, signature });
		expect(() => run?.(verifies)).toThrow("verify returned true, but the case is invalid.");
	});

	test("fail an invalid case whose signing call returns", () => {
		const run = runOf("Wycheproof sign_seed with a message");
		const signs = fixture({
			suite: "Wycheproof sign_seed",
			result: "invalid",
			seed,
			publicKey,
			message,
			signature,
		});
		expect(() => run?.(signs)).toThrow("sign returned, but the case expects a RangeError.");
	});

	test("fail a refused input whose error isn't a RangeError", () => {
		const run = runOf("Wycheproof sign_seed with a seed of the wrong length or a long context");
		const shared = fixture({
			suite: "Wycheproof sign_seed",
			result: "invalid",
			seed: new Uint8Array(new SharedArrayBuffer(31)),
			message,
		});
		expect(() => run?.(shared)).toThrow(
			'keygen threw "mlDsa44.keygen: seed must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as new Uint8Array(new ArrayBuffer(32)) filled with set.", but the case expects a RangeError.',
		);
	});
});

describe("countFailures", () => {
	test("names a row whose number of cases differs from its pinned count", () => {
		const pinned = row("pinned", { cases: 2 });
		const routing = route([fixture()], [pinned]);
		expect(countFailures(routing)).toStrictEqual([
			'The row "pinned" got 1 cases, but its pinned count is 2.',
		]);
		expect(countFailures(route([fixture(), fixture()], [pinned]))).toStrictEqual([]);
	});
});

describe("shapeFailures", () => {
	const bytes = (length: number): Uint8Array => new Uint8Array(length);
	const acvpSigVer = {
		suite: "ACVP sigVer",
		signatureInterface: "external",
		preHash: "pure",
		message: bytes(1),
		context: bytes(0),
	} as const;
	const acvpSigGen = {
		...acvpSigVer,
		suite: "ACVP sigGen",
		deterministic: true,
		secretKey: bytes(2560),
	} as const;

	// Each case breaks exactly one rule.
	test.each<readonly [string, Partial<VectorCase>]>([
		[
			"Internal means a message representative and no message",
			{
				suite: "Wycheproof sign_seed",
				flags: ["Internal"],
				message: bytes(1),
				messageRepresentative: bytes(64),
			},
		],
		[
			"Randomized means signing randomness",
			{ suite: "Wycheproof sign_seed", flags: ["Randomized"], message: bytes(1) },
		],
		[
			"InvalidContext means a context longer than 255 bytes",
			{ flags: ["InvalidContext"], context: bytes(255) },
		],
		[
			"IncorrectPrivateKeyLength means a seed or secret key of the wrong length",
			{ flags: ["IncorrectPrivateKeyLength"], seed: bytes(32) },
		],
		[
			"IncorrectPublicKeyLength means a public key of the wrong length",
			{ flags: ["IncorrectPublicKeyLength"], publicKey: bytes(1312) },
		],
		[
			"IncorrectSignatureLength means a signature of the wrong length",
			{ flags: ["IncorrectSignatureLength"], signature: bytes(2420) },
		],
		[
			"externalMu means a message representative and no message",
			{ ...acvpSigVer, signatureInterface: "internal", externalMu: true, context: undefined },
		],
		[
			"an ACVP signing or verification case gives exactly one of a message and a message representative",
			{ ...acvpSigVer, messageRepresentative: bytes(64) },
		],
		[
			"an ACVP signing or verification case gives exactly one of a message and a message representative",
			{ ...acvpSigVer, message: undefined },
		],
		["the external interface means a context string", { ...acvpSigVer, context: undefined }],
		["preHash means a hash function", { ...acvpSigVer, preHash: "preHash" }],
		["deterministic means no signing randomness", { ...acvpSigGen, randomness: bytes(32) }],
		[
			"keyFormat seed means a seed, and any other key format a secret key",
			{ ...acvpSigGen, suite: "ACVP sigGen tr1", keyFormat: "seed" },
		],
	])("names fixture %# for the rule %s", (rule, fields) => {
		expect(shapeFailures([fixture(fields)])).toStrictEqual([
			`fixture tcId 1 breaks the shape rule "${rule}".`,
		]);
	});
});

describe("segmentCounts", () => {
	test("counts a case once per segment, in the column of its row's path", () => {
		const publicRow = row("public", {
			matches: (vector) => vector.label === "public",
			segments: () => ["input checks", "input checks", "verification"],
		});
		const testOnlyRow = row("test-only", {
			path: "test-only",
			matches: (vector) => vector.label === "test-only",
			segments: () => ["input checks"],
		});
		const routing = route(
			[fixture({ label: "public" }), fixture({ label: "test-only" })],
			[publicRow, testOnlyRow],
		);
		expect(segmentCounts(routing)).toStrictEqual(
			new Map([
				["input checks", { publicRows: 1, testOnlyRows: 1 }],
				["verification", { publicRows: 1, testOnlyRows: 0 }],
			]),
		);
	});
});

describe("segmentFailures", () => {
	const backed: Segment = { public: true, tests: [], cases: { publicRows: 3, testOnlyRows: 1 } };

	test("passes a segment whose counts equal its pinned counts", () => {
		const counts = new Map([["backed", { publicRows: 3, testOnlyRows: 1 }]]);
		expect(segmentFailures({ backed }, counts)).toStrictEqual([]);
	});

	test("names a segment whose counts moved", () => {
		const counts = new Map([["backed", { publicRows: 2, testOnlyRows: 1 }]]);
		expect(segmentFailures({ backed }, counts)).toStrictEqual([
			'The segment "backed" got 2 cases through public rows and 1 through test-only rows, but the table pins 3 and 1.',
		]);
	});

	test("names a public segment with no cases through public rows and no named test", () => {
		const bare: Segment = { public: true, tests: [], cases: { publicRows: 0, testOnlyRows: 4 } };
		const hidden: Segment = { ...bare, public: false };
		const counts = new Map([
			["bare", { publicRows: 0, testOnlyRows: 4 }],
			["hidden", { publicRows: 0, testOnlyRows: 4 }],
		]);
		expect(segmentFailures({ bare, hidden }, counts)).toStrictEqual([
			'The public segment "bare" has no vector cases through public rows and no named test.',
		]);
	});

	test("names a test that its file doesn't hold", () => {
		const named: Segment = {
			public: true,
			tests: [{ file: "zero-checks.test.ts", title: "a test that doesn't exist" }],
			cases: noCases,
		};
		expect(segmentFailures({ named }, new Map())).toStrictEqual([
			'The segment "named" names the test "a test that doesn\'t exist", which test/zero-checks.test.ts doesn\'t hold.',
		]);
	});
});
