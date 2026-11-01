// The depth sweep, in Node. It runs keygen, sign, and verify at the JavaScript
// depths around the engine's stack limit, so that a stack overflow lands at
// every point of a call, inside the wasm module included, and checks the
// stack-edge contract and the wipe after each call.
//
// The sweep runs a one-module bundle of the source. The test runner reads each
// cross-module import through a getter whose `catch` returns `undefined`. At
// the stack limit, such a read can give `undefined`, which would add
// `TypeError`s that the shipped files never throw.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, test } from "vite-plus/test";
import { rolldown } from "vite/rolldown";

import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";

import type * as PublicEntry from "../src/index.js";
import type * as TestOnlyEntry from "../src/testing.js";
import { describeResult, isBytes, type Result } from "./exit-helpers.js";
import {
	firstDifference,
	isAllZero,
	messageOf,
	prototypeOf,
	seedFrom,
	untypedFunction,
} from "./helpers.js";

type Bundled = typeof PublicEntry & typeof TestOnlyEntry;

/** Bundles both entries of the source into one module and imports it. */
async function importBundle(): Promise<Bundled> {
	const source = join(import.meta.dirname, "../src");
	const entry = "\0depth-sweep-entry";
	const bundle = await rolldown({
		input: entry,
		plugins: [
			{
				name: "depth-sweep",
				resolveId: (id) => (id === entry ? id : null),
				load: (id) => {
					if (id === entry) {
						const entries = ["index.ts", "testing.ts"].map((file) => join(source, file));
						return entries.map((file) => `export * from ${JSON.stringify(file)};`).join("\n");
					}
					// The default entry imports the wasm module as base64 text.
					return id.endsWith(".wasm")
						? `export default ${JSON.stringify(readFileSync(id).toString("base64"))};`
						: null;
				},
			},
		],
	});
	const { output } = await bundle.generate({ format: "esm" });
	const file = join(mkdtempSync(join(tmpdir(), "ml-dsa-depth-sweep-")), "bundle.mjs");
	writeFileSync(file, output[0].code);
	return import(pathToFileURL(file).href);
}

// The function at the bottom of every probe and every call. A new closure
// there would make the engine deoptimize the recursion, which changes the size
// of its frames between the probe and the call.
let task: () => void = () => undefined;
let probing = true;

function runTask(): void {
	if (!probing) {
		task();
	}
}

function atDepth(depth: number): void {
	if (depth > 0) {
		atDepth(depth - 1);
		return;
	}
	runTask();
}

function fits(depth: number): boolean {
	probing = true;
	try {
		atDepth(depth);
		return true;
	} catch {
		return false;
	} finally {
		probing = false;
	}
}

/** The deepest recursion that fits on the stack right now. */
function stackLimit(): number {
	let low = 0;
	let high = 1024;
	while (fits(high)) {
		low = high;
		high *= 2;
	}
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (fits(middle)) {
			low = middle;
		} else {
			high = middle;
		}
	}
	return low;
}

// What the last call returned or threw. The call's own `catch` only assigns
// these, so it can't fail at the stack limit.
let started = false;
let threw = false;
let returnedValue: unknown = undefined;
let thrownError: unknown = undefined;

function isBareOverflow(error: unknown): boolean {
	return (
		prototypeOf(error) === RangeError.prototype &&
		messageOf(error) === "Maximum call stack size exceeded"
	);
}

/** Whether `error` is a stack overflow whose innermost frame is a wasm frame. */
function overflowedInWasm(error: unknown): boolean {
	const stack: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "stack") : undefined;
	const innermost = typeof stack === "string" ? (stack.split("\n")[1] ?? "") : "";
	return isBareOverflow(error) && innermost.includes("wasm://");
}

function isPackageError(error: unknown, site: string): boolean {
	return prototypeOf(error) === Error.prototype && messageOf(error) === `${site}: the call failed.`;
}

/** Whether `error` is the type check's error for a string in place of `input`. */
function isTypeCheck(error: unknown, site: string, input: string): boolean {
	return (
		prototypeOf(error) === TypeError.prototype &&
		messageOf(error) === `${site}: ${input} must be a Uint8Array, but typeof ${input} is "string".`
	);
}

/** One input to sweep, and whether a result is one that the stack-edge contract allows. */
interface SweepCase {
	readonly call: () => unknown;
	readonly allowed: (result: Result) => boolean;
}

/** The results of one sweep. */
interface Sweep {
	readonly mismatches: readonly string[];
	readonly wasmOverflows: number;
}

const firstWindow = 256;
const lastWindow = 8192;
const wantedWasmOverflows = 5;

/**
 * Runs `sweepCase` at each depth from the stack limit down. If `reachesWasm`
 * is set, the window of `firstWindow` depths doubles, up to `lastWindow`,
 * until the test record has held `wantedWasmOverflows` overflows inside the
 * wasm module.
 */
function sweep(bundled: Bundled, sweepCase: SweepCase, reachesWasm: boolean): Sweep {
	const { currentMemory, freshMemory, setRecording, testRecord } = bundled;
	const { call } = sweepCase;
	task = () => {
		started = true;
		try {
			returnedValue = call();
		} catch (error) {
			threw = true;
			thrownError = error;
		}
	};
	// Each function reaches its top tier first, so the frame sizes stay put.
	for (let round = 0; round < 200; round += 1) {
		atDepth(50);
		fits(1000);
	}
	const mismatches: string[] = [];
	let wasmOverflows = 0;
	let window = firstWindow;
	let limit = 0;
	for (let step = 0; step < window; step += 1) {
		// The limit moves when the engine optimizes code, so the sweep measures
		// it again every 16 depths.
		if (step % 16 === 0) {
			limit = stackLimit();
		}
		setRecording(true);
		started = false;
		threw = false;
		returnedValue = undefined;
		thrownError = undefined;
		const before = currentMemory();
		try {
			atDepth(limit - step);
		} catch {
			// The overflow came before the call started, so `started` stays false.
		}
		const record = testRecord();
		setRecording(false);
		if (record !== null && overflowedInWasm(record.failure)) {
			wasmOverflows += 1;
		}
		const result: Result = threw
			? { kind: "threw", error: thrownError }
			: { kind: "returned", value: returnedValue };
		const at = `At depth ${limit - step}, the call ${describeResult(result)}`;
		if (started && !sweepCase.allowed(result)) {
			mismatches.push(`${at}, which the stack-edge contract doesn't allow.`);
		}
		const after = currentMemory();
		if (after !== null && firstDifference(after, freshMemory) !== null) {
			mismatches.push(`${at}, and the instance in the slot differs from a fresh instance.`);
		}
		if (before !== null && after !== before && !isAllZero(before)) {
			mismatches.push(`${at}, and the instance that it dropped isn't all zeros.`);
		}
		if (step === window - 1 && reachesWasm && wasmOverflows < wantedWasmOverflows) {
			window = Math.min(window * 2, lastWindow);
		}
	}
	return { mismatches, wasmOverflows };
}

const objectName = "mlDsa87";
const seed = seedFrom(80);
const message = new Uint8Array([1, 2, 3]);
const { publicKey, secretKey } = ml_dsa87.keygen(seed);
const signature = ml_dsa87.sign(message, secretKey, { extraEntropy: false });

const caseNames = [
	"keygen",
	"keygen with a wrong-type seed",
	"sign",
	"sign with a wrong-type seed",
	"verify",
	"verify with a wrong-type public key",
] as const;

type CaseName = (typeof caseNames)[number];

/** The calls to sweep, keyed by name, on the bundle's `mlDsa87`. */
function sweepCases(object: Bundled["mlDsa87"]): Readonly<Record<CaseName, SweepCase>> {
	// The functions are read here, so no property read runs at depth.
	const { keygen, sign, verify } = object;
	const keygenSite = `${objectName}.keygen`;
	const signSite = `${objectName}.sign`;
	const signOptions = { seed, message, randomness: "deterministic" } as const;
	const verifyOptions = { publicKey, message, signature };
	const wrongType = { ...signOptions, seed: "x" };
	const wrongTypeKey = { ...verifyOptions, publicKey: "x" };
	const keygenUntyped = untypedFunction(object, "keygen");
	const signUntyped = untypedFunction(object, "sign");
	const verifyUntyped = untypedFunction(object, "verify");
	const returnedBytes = (result: Result, expected: Uint8Array): boolean => {
		const { value } = result.kind === "returned" ? result : { value: undefined };
		return isBytes(value) && firstDifference(value, expected) === null;
	};
	return {
		keygen: {
			call: () => keygen(seed).publicKey,
			allowed: (result) =>
				result.kind === "returned"
					? returnedBytes(result, publicKey)
					: isPackageError(result.error, keygenSite) || isBareOverflow(result.error),
		},
		"keygen with a wrong-type seed": {
			call: () => keygenUntyped("x"),
			allowed: (result) =>
				result.kind === "threw" &&
				(isTypeCheck(result.error, keygenSite, "seed") || isBareOverflow(result.error)),
		},
		sign: {
			call: () => sign(signOptions),
			allowed: (result) =>
				result.kind === "returned"
					? returnedBytes(result, signature)
					: isPackageError(result.error, signSite) || isBareOverflow(result.error),
		},
		"sign with a wrong-type seed": {
			call: () => signUntyped(wrongType),
			allowed: (result) =>
				result.kind === "threw" &&
				(isTypeCheck(result.error, signSite, "seed") || isBareOverflow(result.error)),
		},
		verify: {
			call: () => verify(verifyOptions),
			allowed: (result) =>
				result.kind === "returned"
					? typeof result.value === "boolean"
					: isBareOverflow(result.error),
		},
		"verify with a wrong-type public key": {
			call: () => verifyUntyped(wrongTypeKey),
			allowed: (result) =>
				result.kind === "returned" ? result.value === false : isBareOverflow(result.error),
		},
	};
}

// Only valid inputs reach the module, so only they must overflow inside it.
const reachingWasm = new Set(["keygen", "sign", "verify"]);

describe(`the depth sweep of ${objectName}`, () => {
	let bundled: Bundled | undefined = undefined;
	beforeAll(async () => {
		bundled = await importBundle();
	});

	test.each(caseNames)(
		"runs %s around the stack limit, keeps to the stack-edge contract, and wipes after every call",
		(name) => {
			if (bundled === undefined) {
				throw new Error("The bundle didn't load.");
			}
			const sweepCase = sweepCases(bundled.mlDsa87)[name];
			const swept = sweep(bundled, sweepCase, reachingWasm.has(name));
			expect(swept.mismatches).toStrictEqual([]);
			if (reachingWasm.has(name)) {
				expect(swept.wasmOverflows).toBeGreaterThanOrEqual(wantedWasmOverflows);
			}
		},
		120_000,
	);
});
