// The calls of the exit matrix and its two helpers. A base is one keygen,
// sign, or verify call with inputs that give a reference output from noble.
// The healthy and the poisoned helper check a call's exit, and like every
// check here they return a list of mismatches instead of asserting, so any
// runner, such as a dedicated worker, can use them.

import type { ObjectName } from "../src/parameter-sets.js";
import {
	checkedOutMemory,
	currentMemory,
	freshMemory,
	layout,
	setExportHook,
	testRecord,
	type ExportHook,
} from "../src/testing.js";
import {
	byteSource,
	firstDifference,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	untypedFunction,
	type ParameterSetCase,
} from "./helpers.js";

export type Operation = "keygen" | "sign" | "verify";

export type MessageShape = "empty" | "one chunk" | "several chunks";

/**
 * One call of the exit matrix: an operation of one parameter set, with one
 * message shape. Its inputs give a reference output from noble.
 */
export interface Base {
	readonly objectName: ObjectName;
	readonly operation: Operation;
	/** The message's shape, or `null` for keygen, which takes no message. */
	readonly shape: MessageShape | null;
}

// Several chunks means two full chunks and one byte more.
const messageLengths: Readonly<Record<MessageShape, number>> = {
	empty: 0,
	"one chunk": 1000,
	"several chunks": 2 * layout.regions.chunk.length + 1,
};

/** The inputs of a base and its reference output from noble. */
interface Inputs {
	readonly seed: Uint8Array<ArrayBuffer>;
	readonly message: Uint8Array<ArrayBuffer>;
	readonly context: Uint8Array<ArrayBuffer>;
	readonly randomness: Uint8Array<ArrayBuffer>;
	readonly publicKey: Uint8Array;
	readonly signature: Uint8Array;
}

function parameterSetCase(objectName: ObjectName): ParameterSetCase {
	const found = parameterSetCases.find((candidate) => candidate.objectName === objectName);
	if (found === undefined) {
		throw new Error(`No parameter set case is named ${objectName}.`);
	}
	return found;
}

const inputCache = new Map<string, Inputs>();

export function inputsOf(base: Base): Inputs {
	const key = `${base.objectName} ${base.shape ?? "empty"}`;
	const cached = inputCache.get(key);
	if (cached !== undefined) {
		return cached;
	}
	const { noble } = parameterSetCase(base.objectName);
	const bytes = byteSource(0x5eed_0070);
	const seed = seedFrom(70);
	const message = bytes(messageLengths[base.shape ?? "empty"]);
	const context = bytes(3);
	const randomness = bytes(32);
	const { publicKey, secretKey } = noble.keygen(seed);
	const signature = noble.sign(message, secretKey, { context, extraEntropy: randomness });
	const inputs: Inputs = { seed, message, context, randomness, publicKey, signature };
	inputCache.set(key, inputs);
	return inputs;
}

/** What a call returned or threw. */
export type Result =
	| { readonly kind: "returned"; readonly value: unknown }
	| { readonly kind: "threw"; readonly error: unknown };

function resultOf(action: () => unknown): Result {
	try {
		return { kind: "returned", value: action() };
	} catch (error) {
		return { kind: "threw", error };
	}
}

function signOptions(inputs: Inputs): Record<string, unknown> {
	const { seed, message, context, randomness } = inputs;
	return { seed, message, context, randomness };
}

function verifyOptions(inputs: Inputs): Record<string, unknown> {
	const { publicKey, message, signature, context } = inputs;
	return { publicKey, message, signature, context };
}

/**
 * Calls the operation of `base` with options that go through `adjust` first,
 * through an untyped view of the object, so a row can pass any value. Keygen's
 * options are `{ seed }`, and keygen gets their `seed`, or the adjusted value
 * itself if it isn't an object.
 */
export function invoke(base: Base, adjust: (options: Record<string, unknown>) => unknown): Result {
	const inputs = inputsOf(base);
	const call = untypedFunction(parameterSetCase(base.objectName).object, base.operation);
	if (base.operation === "keygen") {
		return resultOf(() => {
			const options = adjust({ seed: inputs.seed });
			const seed: unknown =
				typeof options === "object" && options !== null ? Reflect.get(options, "seed") : options;
			return Reflect.get(Object(call(seed)), "publicKey");
		});
	}
	const options = base.operation === "sign" ? signOptions(inputs) : verifyOptions(inputs);
	return resultOf(() => call(adjust(options)));
}

export const unchanged = (options: Record<string, unknown>): unknown => options;

/** The reference output of `base`: the public key, the signature, or `true`. */
export function reference(base: Base): unknown {
	const inputs = inputsOf(base);
	switch (base.operation) {
		case "keygen":
			return inputs.publicKey;
		case "sign":
			return inputs.signature;
		case "verify":
			return true;
	}
}

/** What the caller must get from a call. */
export type Expected =
	| { readonly kind: "reference" }
	| { readonly kind: "false" }
	| { readonly kind: "package Error"; readonly cause: Cause }
	| { readonly kind: "thrown"; readonly error: unknown }
	| { readonly kind: "check error"; readonly prototype: object; readonly messageStart: string };

/** The `cause` of a package `Error`: this exact value, a `{ code }`, or an `Error` with this message. */
export type Cause =
	| { readonly kind: "exactly"; readonly value: unknown }
	| { readonly kind: "code"; readonly code: number }
	| { readonly kind: "message"; readonly message: string };

/** Whether `value` is a plain `Uint8Array`, as every output of the package is. */
export function isBytes(value: unknown): value is Uint8Array {
	return prototypeOf(value) === Uint8Array.prototype;
}

export function describeValue(value: unknown): string {
	if (isBytes(value)) {
		return `${value.length} bytes`;
	}
	if (typeof value === "object" && value !== null) {
		const message: unknown = Reflect.get(value, "message");
		const name: unknown = Reflect.get(value, "name");
		return typeof message === "string" ? `${String(name)}: ${message}` : JSON.stringify(value);
	}
	return String(value);
}

export function describeResult(result: Result): string {
	return result.kind === "returned"
		? `returned ${describeValue(result.value)}`
		: `threw ${describeValue(result.error)}`;
}

function bytesEqual(value: unknown, expected: unknown): boolean {
	return isBytes(value) && isBytes(expected) && firstDifference(value, expected) === null;
}

function causeMatches(cause: unknown, expected: Cause): boolean {
	switch (expected.kind) {
		case "exactly":
			return cause === expected.value;
		case "code":
			return (
				typeof cause === "object" &&
				cause !== null &&
				Reflect.ownKeys(cause).length === 1 &&
				Reflect.get(cause, "code") === expected.code
			);
		case "message":
			return (
				prototypeOf(cause) === Error.prototype &&
				Reflect.get(Object(cause), "message") === expected.message
			);
	}
}

export function resultMismatches(
	base: Base,
	result: Result,
	expected: Expected,
): readonly string[] {
	const got = describeResult(result);
	switch (expected.kind) {
		case "reference":
			return result.kind === "returned" &&
				(base.operation === "verify"
					? result.value === true
					: bytesEqual(result.value, reference(base)))
				? []
				: [`The call ${got} instead of the reference output.`];
		case "false":
			return result.kind === "returned" && result.value === false
				? []
				: [`The call ${got} instead of returning false.`];
		case "thrown":
			return result.kind === "threw" && result.error === expected.error
				? []
				: [`The call ${got} instead of throwing ${describeValue(expected.error)}.`];
		case "check error": {
			const message: unknown =
				result.kind === "threw" ? Reflect.get(Object(result.error), "message") : undefined;
			return result.kind === "threw" &&
				prototypeOf(result.error) === expected.prototype &&
				typeof message === "string" &&
				message.startsWith(expected.messageStart)
				? []
				: [
						`The call ${got} instead of the check's error, which starts "${expected.messageStart}".`,
					];
		}
		case "package Error": {
			const error = result.kind === "threw" ? result.error : undefined;
			return prototypeOf(error) === Error.prototype &&
				Reflect.get(Object(error), "message") ===
					`${base.objectName}.${base.operation}: the call failed.` &&
				causeMatches(Reflect.get(Object(error), "cause"), expected.cause)
				? []
				: [`The call ${got} instead of the package Error with the expected cause.`];
		}
	}
}

/**
 * What a failed keygen or sign throws, or `false`, which verify returns for
 * any failure.
 */
export function failedCall(base: Base, cause: Cause): Expected {
	return base.operation === "verify" ? { kind: "false" } : { kind: "package Error", cause };
}

/**
 * What the test record must hold after a call: the failure, or `null` for no
 * exception, and whether the call dropped its instance. A row whose call never
 * reached the core expects `null`.
 */
type ExpectedRecord = { readonly failure: Cause | null; readonly dropped: boolean } | null;

/** The record of a call that caught `failure` and dropped its instance. */
export function droppedAfter(failure: unknown): ExpectedRecord {
	return { failure: { kind: "exactly", value: failure }, dropped: true };
}

/** The record of a call that caught no exception and kept its instance. */
export const kept: ExpectedRecord = { failure: null, dropped: false };

/**
 * The record of a call that caught no exception but dropped its instance,
 * because an inner call zeroed it.
 */
export const zeroedByInnerCall: ExpectedRecord = { failure: null, dropped: true };

/**
 * Checks the test record after a call. With recording off, or after a call
 * that never reached the core, the record must be empty.
 */
export function recordMismatches(recording: boolean, expected: ExpectedRecord): readonly string[] {
	const record = testRecord();
	if (!recording || expected === null) {
		return record === null ? [] : [`The record isn't empty: ${describeValue(record.failure)}.`];
	}
	if (record === null) {
		return ["The record is empty."];
	}
	const mismatches: string[] = [];
	const keys = Reflect.ownKeys(record);
	if (keys.length !== 2 || !keys.includes("failure") || !keys.includes("dropped")) {
		mismatches.push(`The record holds the keys ${keys.map(String).join(", ")}.`);
	}
	const failureMatches =
		expected.failure === null
			? record.failure === undefined
			: causeMatches(record.failure, expected.failure);
	if (!failureMatches) {
		mismatches.push(`The record holds the failure ${describeValue(record.failure)}.`);
	}
	if (record.dropped !== expected.dropped) {
		mismatches.push(`The record says dropped is ${String(record.dropped)}.`);
	}
	return mismatches;
}

/** A mismatch if `checkedOut` is still set after a row's call returned or threw. */
function checkedOutMismatches(): readonly string[] {
	return checkedOutMemory() === null ? [] : ["`checkedOut` isn't null."];
}

/**
 * The healthy helper. It checks that the slot holds `held`, the instance that
 * the call checked out, or any instance if `held` is `null`, that its whole
 * memory equals a fresh instance's memory, that `checkedOut` is `null`, and
 * that the caller got `expected`.
 */
export function healthyMismatches(
	base: Base,
	held: Uint8Array | null,
	result: Result,
	expected: Expected,
): readonly string[] {
	const mismatches = [...resultMismatches(base, result, expected), ...checkedOutMismatches()];
	const memory = currentMemory();
	if (memory === null) {
		return [...mismatches, "The slot is empty."];
	}
	if (held !== null && memory !== held) {
		mismatches.push("The slot holds another instance than the one that the call checked out.");
	}
	const offset = firstDifference(memory, freshMemory);
	if (offset !== null) {
		mismatches.push(`Memory differs from a fresh instance's memory at offset ${offset}.`);
	}
	return mismatches;
}

export function firstNonZero(memory: Uint8Array): number | null {
	const offset = memory.findIndex((byte) => byte !== 0);
	return offset === -1 ? null : offset;
}

/**
 * The poisoned helper. It checks that the dropped instance's whole memory
 * reads zero, that the slot is empty, that `checkedOut` is `null`, that the
 * caller got `expected`, and that the next call returns the reference
 * output on a new instance. `dropped` is `null` when the call never had an
 * instance. After an inner call zeroed the instance, `inner` is the
 * memory of the inner call's instance, which the slot may hold.
 */
export function poisonedMismatches(
	base: Base,
	dropped: Uint8Array | null,
	result: Result,
	expected: Expected,
	inner: Uint8Array | null = null,
): readonly string[] {
	const mismatches = [...resultMismatches(base, result, expected), ...checkedOutMismatches()];
	const offset = dropped === null ? null : firstNonZero(dropped);
	if (offset !== null) {
		mismatches.push(`The dropped instance's memory isn't zero at offset ${offset}.`);
	}
	const slot = currentMemory();
	if (slot !== null && slot !== inner) {
		mismatches.push(
			inner === null
				? "The slot isn't empty."
				: "The slot holds an instance other than the inner call's.",
		);
	}
	const next = invoke(base, unchanged);
	mismatches.push(
		...resultMismatches(base, next, { kind: "reference" }).map((mismatch) => `Next: ${mismatch}`),
	);
	const memory = currentMemory();
	if (memory === null || memory === dropped) {
		mismatches.push("The next call didn't leave a new instance in the slot.");
	} else if (firstDifference(memory, freshMemory) !== null) {
		mismatches.push("After the next call, memory differs from a fresh instance's memory.");
	}
	return mismatches;
}

/** The live memory of the instance in the slot. Throws if the slot is empty. */
export function slotMemory(): Uint8Array<ArrayBuffer> {
	const memory = currentMemory();
	if (memory === null) {
		throw new Error("The slot is empty before a row.");
	}
	return memory;
}

/** Runs `action` with `hook` in place of each export call. */
export function runHooked(hook: ExportHook, action: () => Result): Result {
	setExportHook(hook);
	try {
		return action();
	} finally {
		setExportHook(null);
	}
}
