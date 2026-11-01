// The rows of the exit matrix. Each row is plain data: a base, and the fault
// or the situation that its call meets. A counting run generates one set of
// rows, and the listed rows cover the situations that no generated row
// reaches.

import type { FunctionName } from "../src/module-exports.js";
import type { ObjectName } from "../src/parameter-sets.js";
import { cleanupPausesOf, type PausePoint } from "./debugger-pauses.js";
import { parameterSetCases } from "./helpers.js";
import {
	type Base,
	type MessageShape,
	type Operation,
	invoke,
	resultMismatches,
	runHooked,
	unchanged,
} from "./exit-helpers.js";

/**
 * A fault that the export hook injects at the export call with index `at`,
 * counted from 0 within one call. The hook runs the export first, so the
 * fault comes after the export's own writes.
 */
export interface Fault {
	/**
	 * `trap` makes an out-of-bounds call into the module, `throw` throws a
	 * `RangeError`, and `status` returns a non-zero code, or a zero length
	 * from the prefix export.
	 */
	readonly kind: "trap" | "throw" | "status";
	readonly at: number;
}

/** A row that the counting run generates: one fault at one export call. */
export interface GeneratedRow {
	readonly kind: "generated";
	readonly base: Base;
	readonly fault: Fault;
	/** The export that the fault follows. */
	readonly exportName: FunctionName;
}

/** A check that a call runs before the core, named by what fails it. */
export type PreCheckoutRule =
	| "not an object"
	| "null"
	| "another prototype"
	| "an unknown key"
	| "missing"
	| "wrong type"
	| "bad backing"
	| "wrong length"
	| "all zeros";

/** The input that a check before the core reads, or `options` for the read step. */
export type CheckedInput =
	| "options"
	| "seed"
	| "message"
	| "context"
	| "randomness"
	| "publicKey"
	| "signature";

/** A row whose call fails before the core takes the instance. */
export interface PreCheckoutRow {
	readonly kind: "pre-checkout";
	readonly objectName: ObjectName;
	readonly operation: Operation;
	/** The input that breaks the rule. */
	readonly input: CheckedInput;
	readonly rule: PreCheckoutRule;
}

/** A listed row, which covers one situation that no generated row reaches. */
export type ListedRow =
	| PreCheckoutRow
	| {
			/** A public verify that rejects at the `z` norm check, or after all the matrix work. */
			readonly kind: "rejected verify";
			readonly objectName: ObjectName;
			readonly at: "z norm check" | "final comparison";
	  }
	| {
			/** A call that finds the slot empty, and whose creation fails once. */
			readonly kind: "failed creation";
			readonly base: Base;
			readonly failure:
				| "an injected error"
				| "a memory of the wrong size"
				| "regions past the heap";
	  }
	| {
			/** A failing status, then a release that throws. */
			readonly kind: "status, then a throwing release";
			readonly base: Base;
	  }
	| {
			/**
			 * From the last export call on, every `fill` and every `WeakSet` lookup
			 * throws, after healthy work or after an exception.
			 */
			readonly kind: "throwing fills";
			readonly base: Base;
			readonly after: "healthy work" | "an exception";
	  }
	| {
			/** `new Error` throws while the core builds the package `Error`. */
			readonly kind: "throwing Error constructor";
			readonly base: Base;
			readonly after: "an exception" | "a status";
	  }
	| {
			/** A getter of the outer call's options runs a nested call during the read step. */
			readonly kind: "getter";
			readonly base: Base;
			readonly nested: "sign" | "verify" | "trap";
	  }
	| {
			/**
			 * An export hook of the outer call runs a public sign while the outer
			 * call holds the instance: the hook of the work's last export call, or
			 * of the release inside the `finally` block.
			 */
			readonly kind: "public call from an export hook";
			readonly base: Base;
			readonly at: "the work's last export call" | "the release";
	  }
	| {
			/** A debugger pauses the outer call at `point` of its cleanup, and runs a public sign. */
			readonly kind: "public call from a debugger pause";
			readonly base: Base;
			readonly point: PausePoint;
	  };

export type Row = GeneratedRow | ListedRow;

const shapes: readonly MessageShape[] = ["empty", "one chunk", "several chunks"];

/** The only export whose failing status is a zero length, not a non-zero code. */
export const prefixExport = "mldsa44_prepare_domain_separation_prefix";

/** The non-zero code that a row returns in place of an export's status. */
export const failingCode = 7;

/**
 * Whether the export returns a status: a code or a length that a row can
 * replace with a failing one. Verify turns a failing status from the
 * verification export into its answer `false`.
 */
function returnsStatus(name: FunctionName): boolean {
	return (
		name.endsWith("_keypair_internal") ||
		name.endsWith("_signature_internal") ||
		name.endsWith("_verify_extmu") ||
		name === prefixExport
	);
}

/**
 * The failing status that a row returns for the export: a zero length from
 * the prefix export, or `failingCode` from any other.
 */
export function injectedStatus(name: FunctionName): number {
	return name === prefixExport ? 0 : failingCode;
}

/** The export calls that `base` makes, in order, from a run without faults. */
export function exportCallsOf(base: Base): readonly FunctionName[] {
	const names: FunctionName[] = [];
	const result = runHooked(
		(call) => {
			names.push(call.name);
			return call.proceed();
		},
		() => invoke(base, unchanged),
	);
	const mismatches = resultMismatches(base, result, { kind: "reference" });
	if (mismatches.length > 0) {
		throw new Error(`The counting run failed: ${mismatches.join(" ")}`);
	}
	return names;
}

/** Every base: keygen, and sign and verify with each message shape, for every parameter set. */
export const bases: readonly Base[] = parameterSetCases.flatMap(({ objectName }) => [
	{ objectName, operation: "keygen", shape: null },
	...shapes.flatMap((shape): Base[] => [
		{ objectName, operation: "sign", shape },
		{ objectName, operation: "verify", shape },
	]),
]);

/**
 * The generated rows. A counting run of each base lists its export calls. At
 * each call, one row injects a trap and one throws a `RangeError`. At each
 * call that returns a status, one more row injects a failing status.
 */
export function generatedRows(): readonly GeneratedRow[] {
	return bases.flatMap((base) =>
		exportCallsOf(base).flatMap((exportName, at): GeneratedRow[] => [
			{ kind: "generated", base, exportName, fault: { kind: "trap", at } },
			{ kind: "generated", base, exportName, fault: { kind: "throw", at } },
			...(returnsStatus(exportName)
				? [{ kind: "generated", base, exportName, fault: { kind: "status", at } } as const]
				: []),
		]),
	);
}

/**
 * Each check before the core, keyed by operation, with the input that it
 * applies to, in the documented order of the checks.
 */
const preCheckoutStages: Readonly<
	Record<Operation, readonly (readonly [input: CheckedInput, rule: PreCheckoutRule])[]>
> = {
	keygen: [
		["seed", "missing"],
		["seed", "wrong type"],
		["seed", "bad backing"],
		["seed", "wrong length"],
		["seed", "all zeros"],
	],
	sign: [
		["options", "not an object"],
		["options", "null"],
		["options", "another prototype"],
		["options", "an unknown key"],
		["seed", "missing"],
		["seed", "wrong type"],
		["seed", "bad backing"],
		["seed", "wrong length"],
		["message", "missing"],
		["message", "wrong type"],
		["message", "bad backing"],
		["context", "wrong type"],
		["context", "bad backing"],
		["context", "wrong length"],
		["randomness", "missing"],
		["randomness", "wrong type"],
		["randomness", "bad backing"],
		["randomness", "wrong length"],
		["seed", "all zeros"],
		["randomness", "all zeros"],
	],
	verify: [
		["options", "not an object"],
		["options", "null"],
		["options", "another prototype"],
		["options", "an unknown key"],
		["publicKey", "missing"],
		["publicKey", "wrong type"],
		["publicKey", "bad backing"],
		["publicKey", "wrong length"],
		["message", "missing"],
		["message", "wrong type"],
		["message", "bad backing"],
		["signature", "missing"],
		["signature", "wrong type"],
		["signature", "bad backing"],
		["signature", "wrong length"],
		["context", "wrong type"],
		["context", "bad backing"],
		["context", "wrong length"],
	],
};

/** The pre-checkout rows: every check before the core, for every operation and parameter set. */
function preCheckoutRows(objectName: ObjectName): readonly ListedRow[] {
	return (["keygen", "sign", "verify"] as const).flatMap((operation) =>
		preCheckoutStages[operation].map(([input, rule]): ListedRow => ({
			kind: "pre-checkout",
			objectName,
			operation,
			input,
			rule,
		})),
	);
}

/** The listed rows, for every parameter set. */
export function listedRows(): readonly ListedRow[] {
	return parameterSetCases.flatMap(({ objectName }): ListedRow[] => {
		const keygen: Base = { objectName, operation: "keygen", shape: null };
		const sign: Base = { objectName, operation: "sign", shape: "one chunk" };
		const verify: Base = { objectName, operation: "verify", shape: "one chunk" };
		const operations = [keygen, sign, verify];
		return [
			...preCheckoutRows(objectName),
			{ kind: "rejected verify", objectName, at: "z norm check" },
			{ kind: "rejected verify", objectName, at: "final comparison" },
			...operations.flatMap((base) =>
				(["an injected error", "a memory of the wrong size", "regions past the heap"] as const).map(
					(failure): ListedRow => ({ kind: "failed creation", base, failure }),
				),
			),
			{ kind: "status, then a throwing release", base: sign },
			{ kind: "status, then a throwing release", base: verify },
			...operations.flatMap((base) =>
				(["healthy work", "an exception"] as const).map((after): ListedRow => ({
					kind: "throwing fills",
					base,
					after,
				})),
			),
			...[keygen, sign].flatMap((base) =>
				(["an exception", "a status"] as const).map((after): ListedRow => ({
					kind: "throwing Error constructor",
					base,
					after,
				})),
			),
			...[sign, verify].flatMap((base) =>
				(["sign", "verify", "trap"] as const).map((nested): ListedRow => ({
					kind: "getter",
					base,
					nested,
				})),
			),
			...operations.map((base): ListedRow => ({
				kind: "public call from an export hook",
				base,
				at: "the work's last export call",
			})),
			...[sign, verify].map((base): ListedRow => ({
				kind: "public call from an export hook",
				base,
				at: "the release",
			})),
			...operations.flatMap((base) =>
				cleanupPausesOf(() => invoke(base, unchanged)).map((point): ListedRow => ({
					kind: "public call from a debugger pause",
					base,
					point,
				})),
			),
		];
	});
}

function baseName(base: Base): string {
	const shape =
		base.shape === null ? "" : ` with ${base.shape === "empty" ? "an empty" : base.shape} message`;
	return `${base.objectName}.${base.operation}${shape}`;
}

/** A name for the row, unique within the matrix. */
export function rowName(row: Row): string {
	switch (row.kind) {
		case "generated":
			return `${baseName(row.base)}: ${row.fault.kind} after export call ${row.fault.at} (${row.exportName})`;
		case "pre-checkout":
			return `${row.objectName}.${row.operation}: ${row.input}, ${row.rule}`;
		case "rejected verify":
			return `${row.objectName}.verify: a signature rejected at the ${row.at}`;
		case "failed creation":
			return `${baseName(row.base)}: a creation that fails with ${row.failure}`;
		case "status, then a throwing release":
			return `${baseName(row.base)}: a status, then a throwing release`;
		case "throwing fills":
			return `${baseName(row.base)}: throwing fills after ${row.after}`;
		case "throwing Error constructor":
			return `${baseName(row.base)}: a throwing Error constructor after ${row.after}`;
		case "getter":
			return `${baseName(row.base)}: a getter that runs a nested ${row.nested}`;
		case "public call from an export hook":
			return `${baseName(row.base)}: a public sign from the hook of ${row.at}`;
		case "public call from a debugger pause":
			return `${baseName(row.base)}: a public sign from debugger pause ${row.point.position} of the cleanup, before \`${row.point.statement}\``;
	}
}
