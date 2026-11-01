// The runner of the exit matrix. `rowMismatches` runs one row and checks its
// exit with the healthy or the poisoned helper.

import { parameterSets, type ObjectName } from "../src/parameter-sets.js";
import {
	currentMemory,
	emptySlot,
	failNextCreation,
	freshMemory,
	layout,
	pointer,
	setExportHook,
	setRecording,
	type ExportCall,
	type ExportHook,
} from "../src/testing.js";
import { pausedAt } from "./debugger-pauses.js";
import { firstDifference, regionOf } from "./helpers.js";
import {
	type Base,
	type Cause,
	type Expected,
	type Result,
	describeValue,
	droppedAfter,
	failedCall,
	firstNonZero,
	healthyMismatches,
	inputsOf,
	invoke,
	isBytes,
	kept,
	poisonedMismatches,
	recordMismatches,
	resultMismatches,
	runHooked,
	slotMemory,
	zeroedByInnerCall,
	unchanged,
} from "./exit-helpers.js";
import {
	type CheckedInput,
	type GeneratedRow,
	type ListedRow,
	type PreCheckoutRow,
	type PreCheckoutRule,
	type Row,
	exportCallsOf,
	failingCode,
	injectedStatus,
	prefixExport,
} from "./exit-rows.js";

/** The byte that the hook paints over memory that the cleanup must zero. */
const paint = 0xa5;

const lastRegionEnd = Math.max(
	...Object.values(layout.regions).map((region) => region.pointer + region.length),
);

/**
 * A hook that paints the wasm stack and the bytes after the last region
 * before every export call, so a fill that shrank leaves paint behind, then
 * runs `inner`. Each call has its index among the export calls of the row.
 */
function painting(inner: (call: ExportCall, index: number) => number | undefined): ExportHook {
	let index = 0;
	return (call) => {
		call.memory.fill(paint, layout.stack.start, layout.stack.end);
		call.memory.fill(paint, lastRegionEnd);
		const current = index;
		index += 1;
		return inner(call, current);
	};
}

const proceed = (call: ExportCall): number | undefined => call.proceed();

/**
 * Checks that the seed, or the public key for verify, sits in its region at a
 * fault, so no row passes because the fault came before any write.
 */
function inputsInPlace(base: Base, memory: Uint8Array<ArrayBuffer>): readonly string[] {
	const inputs = inputsOf(base);
	const [region, expected, name] =
		base.operation === "verify"
			? [layout.regions.publicKey, inputs.publicKey, "public key"]
			: [layout.regions.seed, inputs.seed, "seed"];
	const held = regionOf(memory, region).subarray(0, expected.length);
	return firstDifference(held, expected) === null
		? []
		: [`At the fault, the ${name} region doesn't hold the ${name}.`];
}

/**
 * Makes a real trap in the module, with an out-of-bounds write past the end of
 * memory, and returns the error that the module threw.
 */
function trapError(call: ExportCall): unknown {
	try {
		call.functions.mldsa_shake256_init(pointer(layout.memoryBytes));
	} catch (error) {
		return error;
	}
	return new Error("The out-of-bounds call returned instead of trapping.");
}

function generatedMismatches(row: GeneratedRow, recording: boolean): readonly string[] {
	const { base, fault } = row;
	const held = slotMemory();
	const mismatches: string[] = [];
	let injected: unknown = undefined;
	const result = runHooked(
		painting((call, index) => {
			if (index !== fault.at) {
				return call.proceed();
			}
			mismatches.push(...inputsInPlace(base, call.memory));
			call.proceed();
			if (fault.kind === "status") {
				return injectedStatus(call.name);
			}
			injected = fault.kind === "trap" ? trapError(call) : new RangeError("injected");
			throw injected;
		}),
		() => invoke(base, unchanged),
	);
	if (fault.kind === "trap" && Reflect.get(Object(injected), "name") !== "RuntimeError") {
		mismatches.push(`The trap threw ${describeValue(injected)} instead of a RuntimeError.`);
	}
	if (fault.kind === "status") {
		const expected = failedCall(base, { kind: "code", code: injectedStatus(row.exportName) });
		mismatches.push(...recordMismatches(recording, kept));
		return [...mismatches, ...healthyMismatches(base, held, result, expected)];
	}
	mismatches.push(...recordMismatches(recording, droppedAfter(injected)));
	const expected = failedCall(base, { kind: "exactly", value: injected });
	return [...mismatches, ...poisonedMismatches(base, held, result, expected)];
}

/** A copy of `bytes` on a resizable buffer, which every byte input rejects. */
function onResizableBuffer(bytes: unknown): Uint8Array {
	const source = isBytes(bytes) ? bytes : new Uint8Array(0);
	const copy = new Uint8Array(new ArrayBuffer(source.length, { maxByteLength: source.length + 8 }));
	copy.set(source);
	return copy;
}

/** Options that break `rule` for `input`, built from valid `options`. */
function breakRule(
	options: Record<string, unknown>,
	input: CheckedInput,
	rule: PreCheckoutRule,
): unknown {
	const value = options[input];
	const length = isBytes(value) ? value.length : 0;
	const replaced = (next: unknown): Record<string, unknown> => ({ ...options, [input]: next });
	switch (rule) {
		case "not an object":
			return 1;
		case "null":
			return null;
		case "another prototype": {
			const withPrototype: object = Object.create({});
			return Object.assign(withPrototype, options);
		}
		case "an unknown key":
			return { ...options, extra: 1 };
		case "missing": {
			const rest = { ...options };
			Reflect.deleteProperty(rest, input);
			return rest;
		}
		case "wrong type":
			return replaced("x".repeat(length));
		case "bad backing":
			return replaced(onResizableBuffer(value));
		case "wrong length":
			return replaced(new Uint8Array(input === "context" ? 256 : length - 1));
		case "all zeros":
			return replaced(new Uint8Array(length));
	}
}

function preCheckoutMismatches(row: PreCheckoutRow, recording: boolean): readonly string[] {
	const base: Base = { objectName: row.objectName, operation: row.operation, shape: "one chunk" };
	const memory = slotMemory();
	memory.fill(paint, layout.heapBase);
	const result = invoke(base, (options) => breakRule(options, row.input, row.rule));
	const lengthRule = row.rule === "wrong length" || row.rule === "all zeros";
	// Each check's message starts with the site and the input that it reads.
	const expected: Expected =
		row.operation === "verify"
			? { kind: "false" }
			: {
					kind: "check error",
					prototype: lengthRule ? RangeError.prototype : TypeError.prototype,
					messageStart: `${row.objectName}.${row.operation}: ${row.input} `,
				};
	const mismatches = [
		...resultMismatches(base, result, expected),
		...recordMismatches(recording, null),
	];
	if (currentMemory() !== memory) {
		mismatches.push("The slot holds another instance.");
	}
	const painted = memory.subarray(layout.heapBase);
	if (!painted.every((byte) => byte === paint)) {
		mismatches.push("The paint after __heap_base changed, so the call wrote to memory.");
	}
	memory.fill(0, layout.heapBase);
	return mismatches;
}

// The challenge hash at the start of a signature is λ/4 bytes long in FIPS 204.
const challengeBytes: Readonly<Record<ObjectName, number>> = {
	mlDsa44: 32,
	mlDsa65: 48,
	mlDsa87: 64,
};

/**
 * A signature that verify rejects at `at`. Three zero bytes after the
 * challenge hash encode the first coefficient of `z` as γ1, which fails the
 * norm check before any matrix work. A flipped challenge hash passes every
 * check up to the final comparison.
 */
function rejectedSignature(
	objectName: ObjectName,
	signature: Uint8Array,
	at: Extract<ListedRow, { kind: "rejected verify" }>["at"],
): Uint8Array {
	const changed = signature.slice();
	const start = challengeBytes[objectName];
	if (at === "z norm check") {
		changed.fill(0, start, start + 3);
	} else {
		changed[0] = (changed[0] ?? 0) ^ 1;
	}
	return changed;
}

/**
 * Puts a fake `WebAssembly.Instance` in place for one construction, which
 * gives these exports and then puts the real constructor back.
 */
function fakeNextInstance(exports: object): void {
	const real: unknown = Reflect.get(WebAssembly, "Instance");
	class Fake {
		readonly exports: object;
		constructor() {
			Reflect.set(WebAssembly, "Instance", real);
			this.exports = exports;
		}
	}
	Reflect.set(WebAssembly, "Instance", Fake);
}

/** Exports with a fixed memory of `memoryBytes`, whose globals hold these values. */
function fakeExports(memoryBytes: number, heapBase: number): object {
	const global = (value: number): object => ({ value });
	return {
		memory: { buffer: new ArrayBuffer(memoryBytes) },
		__stack_low: global(0),
		__stack_high: global(layout.stack.end),
		__heap_base: global(heapBase),
		__heap_end: global(memoryBytes),
	};
}

function failedCreationMismatches(
	row: Extract<ListedRow, { kind: "failed creation" }>,
	recording: boolean,
): readonly string[] {
	const injected = new Error("injected");
	let cause: Cause = { kind: "exactly", value: injected };
	switch (row.failure) {
		case "an injected error":
			failNextCreation(injected);
			break;
		case "a memory of the wrong size":
			emptySlot();
			fakeNextInstance(fakeExports(layout.memoryBytes + 65_536, layout.heapBase));
			cause = {
				kind: "message",
				message:
					"ml-dsa: the wasm module's memory doesn't have the layout that the package was built for.",
			};
			break;
		case "regions past the heap":
			emptySlot();
			fakeNextInstance(fakeExports(layout.memoryBytes, layout.memoryBytes - 64));
			cause = {
				kind: "message",
				message:
					"ml-dsa: the package's memory regions don't fit between __heap_base and __heap_end.",
			};
			break;
	}
	const result = runHooked(painting(proceed), () => invoke(row.base, unchanged));
	return [
		...recordMismatches(recording, { failure: cause, dropped: false }),
		...poisonedMismatches(row.base, null, result, failedCall(row.base, cause)),
	];
}

/** The index of the last export call of `base`. */
function lastExportCall(base: Base): number {
	return exportCallsOf(base).length - 1;
}

/**
 * Runs `action` while every `Uint8Array` fill and every `WeakSet` lookup
 * throws `error`, as both can when too little engine stack is left to start
 * them, from the moment `arm` runs. `arm` defines an own `fill` on
 * `Uint8Array.prototype`, which shadows the `fill` that it inherits from
 * `%TypedArray%.prototype`, so deleting that own property puts the real
 * `fill` back.
 */
function withThrowingFillsAndLookups(error: Error, action: (arm: () => void) => Result): Result {
	const has = Reflect.getOwnPropertyDescriptor(WeakSet.prototype, "has");
	const throwing = {
		value: () => {
			throw error;
		},
	};
	const arm = (): void => {
		Reflect.defineProperty(Uint8Array.prototype, "fill", { configurable: true, ...throwing });
		if (has !== undefined) {
			Reflect.defineProperty(WeakSet.prototype, "has", { ...has, ...throwing });
		}
	};
	try {
		return action(arm);
	} finally {
		Reflect.deleteProperty(Uint8Array.prototype, "fill");
		if (has !== undefined) {
			Reflect.defineProperty(WeakSet.prototype, "has", has);
		}
	}
}

/** Runs `action` while `new Error` throws `error`, from the moment `arm` runs. */
function withThrowingErrorConstructor(error: unknown, action: (arm: () => void) => Result): Result {
	const real = Reflect.getOwnPropertyDescriptor(globalThis, "Error");
	const arm = (): void => {
		Reflect.defineProperty(globalThis, "Error", {
			configurable: true,
			writable: true,
			value: function ThrowingError() {
				throw error;
			},
		});
	};
	try {
		return action(arm);
	} finally {
		if (real !== undefined) {
			Reflect.defineProperty(globalThis, "Error", real);
		}
	}
}

function listedMismatches(row: ListedRow, recording: boolean): readonly string[] {
	switch (row.kind) {
		case "pre-checkout":
			return preCheckoutMismatches(row, recording);
		case "failed creation":
			return failedCreationMismatches(row, recording);
		case "rejected verify": {
			const base: Base = { objectName: row.objectName, operation: "verify", shape: "one chunk" };
			const held = slotMemory();
			const { signature } = inputsOf(base);
			const result = runHooked(painting(proceed), () =>
				invoke(base, (options) => ({
					...options,
					signature: rejectedSignature(row.objectName, signature, row.at),
				})),
			);
			return [
				...recordMismatches(recording, kept),
				...healthyMismatches(base, held, result, { kind: "false" }),
			];
		}
		case "status, then a throwing release": {
			const held = slotMemory();
			const injected = new RangeError("release");
			// The mismatches about what happened during the call: the inputs at
			// the release, and the export calls after the status.
			const duringCall: string[] = [];
			// The core must get a status outcome after a SHAKE256 init, so that the
			// release runs. In sign, the signature export's code becomes one. In
			// verify, the verification export's code becomes the answer `false`
			// instead, so the row takes the zero length from the prefix export,
			// which follows the init of the public-key hash.
			const statusExport =
				row.base.operation === "sign"
					? parameterSets[row.base.objectName].signatureExport
					: prefixExport;
			// The export calls after the status, which must be the release alone.
			let afterStatus: string[] | null = null;
			const result = runHooked(
				painting((call) => {
					afterStatus?.push(call.name);
					const proceeded = call.proceed();
					if (call.name === "mldsa_shake256_release") {
						duringCall.push(...inputsInPlace(row.base, call.memory));
						throw injected;
					}
					if (call.name !== statusExport) {
						return proceeded;
					}
					afterStatus = [];
					return injectedStatus(call.name);
				}),
				() => invoke(row.base, unchanged),
			);
			const calls = JSON.stringify(afterStatus);
			if (calls !== JSON.stringify(["mldsa_shake256_release"])) {
				duringCall.push(`After the status, the call made the export calls ${calls}.`);
			}
			return [
				...duringCall,
				...recordMismatches(recording, droppedAfter(injected)),
				...poisonedMismatches(
					row.base,
					held,
					result,
					failedCall(row.base, { kind: "code", code: injectedStatus(statusExport) }),
				),
			];
		}
		case "throwing fills": {
			const last = lastExportCall(row.base);
			const held = slotMemory();
			const fillError = new RangeError("fill");
			const injected = new RangeError("injected");
			const duringCall: string[] = [];
			const result = withThrowingFillsAndLookups(fillError, (arm) =>
				runHooked(
					painting((call, index) => {
						const proceeded = call.proceed();
						if (index === last) {
							duringCall.push(...inputsInPlace(row.base, call.memory));
							arm();
							if (row.after === "an exception") {
								throw injected;
							}
						}
						return proceeded;
					}),
					() => invoke(row.base, unchanged),
				),
			);
			const first = row.after === "an exception" ? injected : fillError;
			return [
				...duringCall,
				...recordMismatches(recording, droppedAfter(first)),
				...poisonedMismatches(
					row.base,
					held,
					result,
					failedCall(row.base, { kind: "exactly", value: first }),
				),
			];
		}
		case "throwing Error constructor": {
			const held = slotMemory();
			const constructionError = new RangeError("construction");
			const injected = new RangeError("injected");
			const duringCall: string[] = [];
			const result = withThrowingErrorConstructor(constructionError, (arm) =>
				runHooked(
					painting((call, index) => {
						const proceeded = call.proceed();
						if (index !== 0) {
							return proceeded;
						}
						duringCall.push(...inputsInPlace(row.base, call.memory));
						arm();
						if (row.after === "an exception") {
							throw injected;
						}
						return failingCode;
					}),
					() => invoke(row.base, unchanged),
				),
			);
			if (row.after === "a status") {
				return [
					...duringCall,
					...recordMismatches(recording, kept),
					...healthyMismatches(row.base, held, result, {
						kind: "thrown",
						error: constructionError,
					}),
				];
			}
			return [
				...duringCall,
				...recordMismatches(recording, droppedAfter(injected)),
				...poisonedMismatches(row.base, held, result, { kind: "thrown", error: injected }),
			];
		}
		case "getter":
			return getterMismatches(row, recording);
		case "public call from an export hook":
			return callFromHookMismatches(row, recording);
		case "public call from a debugger pause":
			return debuggerPauseMismatches(row, recording);
	}
}

function getterMismatches(
	row: Extract<ListedRow, { kind: "getter" }>,
	recording: boolean,
): readonly string[] {
	const before = slotMemory();
	const mismatches: string[] = [];
	const signBase: Base = { ...row.base, operation: "sign" };
	const verifyBase: Base = { ...row.base, operation: "verify" };
	const outerHook = painting(proceed);
	const nested = (): void => {
		switch (row.nested) {
			case "sign":
			case "verify": {
				const base = row.nested === "sign" ? signBase : verifyBase;
				mismatches.push(
					...resultMismatches(base, invoke(base, unchanged), { kind: "reference" }).map(
						(mismatch) => `Nested: ${mismatch}`,
					),
				);
				break;
			}
			case "trap": {
				const keygenBase: Base = { ...row.base, operation: "keygen", shape: null };
				const dropped = currentMemory();
				let trap: unknown = undefined;
				setExportHook((call) => {
					mismatches.push(...inputsInPlace(keygenBase, call.memory));
					trap = trapError(call);
					throw trap;
				});
				const result = invoke(keygenBase, unchanged);
				setExportHook(outerHook);
				mismatches.push(
					...resultMismatches(keygenBase, result, {
						kind: "package Error",
						cause: { kind: "exactly", value: trap },
					}).map((mismatch) => `Nested: ${mismatch}`),
				);
				if (dropped === null || firstNonZero(dropped) !== null) {
					mismatches.push("The nested trap didn't wipe the instance that it dropped.");
				}
				break;
			}
		}
	};
	const result = runHooked(outerHook, () =>
		invoke(row.base, (options) => {
			const { message } = options;
			return Object.defineProperty({ ...options }, "message", {
				enumerable: true,
				get: () => {
					nested();
					return message;
				},
			});
		}),
	);
	mismatches.push(...recordMismatches(recording, kept));
	// After a nested trap, the outer call runs on the new instance that it
	// creates, so the slot holds no instance from before the call.
	const held = row.nested === "trap" ? null : before;
	if (row.nested === "trap" && currentMemory() === before) {
		mismatches.push("The slot still holds the instance that the nested trap dropped.");
	}
	return [...mismatches, ...healthyMismatches(row.base, held, result, { kind: "reference" })];
}

/** What an inner call returned, and the memory of the instance that it ran on. */
interface InnerCall {
	readonly result: Result;
	readonly memory: Uint8Array | null;
}

/** The base of every inner call: a public sign with a one-chunk message. */
function innerSignBase(objectName: ObjectName): Base {
	return { objectName, operation: "sign", shape: "one chunk" };
}

/**
 * Runs a public sign while the outer call holds its instance, as a call from
 * a debugger console would, then sets the export hook back to `outerHook`.
 */
function innerSign(objectName: ObjectName, outerHook: ExportHook): InnerCall {
	let memory: Uint8Array | null = null;
	setExportHook((call) => {
		memory = call.memory;
		return call.proceed();
	});
	const result = invoke(innerSignBase(objectName), unchanged);
	setExportHook(outerHook);
	return { result, memory };
}

/**
 * Checks a row in which an inner call zeroed the instance that the outer
 * call held: the inner call's output and its own wiped instance, the record,
 * and then the poisoned helper's checks of the outer call.
 */
function innerCallMismatches(
	base: Base,
	held: Uint8Array<ArrayBuffer>,
	result: Result,
	inner: InnerCall | null,
	recording: boolean,
): readonly string[] {
	if (inner === null || inner.memory === null) {
		return ["The inner call never ran."];
	}
	const innerBase = innerSignBase(base.objectName);
	const mismatches = resultMismatches(innerBase, inner.result, { kind: "reference" }).map(
		(mismatch) => `Inner: ${mismatch}`,
	);
	if (inner.memory === held) {
		mismatches.push("The inner call ran on the instance that the outer call held.");
	}
	if (firstDifference(inner.memory, freshMemory) !== null) {
		mismatches.push("The inner call's instance differs from a fresh instance.");
	}
	return [
		...mismatches,
		...recordMismatches(recording, zeroedByInnerCall),
		...poisonedMismatches(
			base,
			held,
			result,
			failedCall(base, { kind: "exactly", value: undefined }),
			inner.memory,
		),
	];
}

function callFromHookMismatches(
	row: Extract<ListedRow, { kind: "public call from an export hook" }>,
	recording: boolean,
): readonly string[] {
	const held = slotMemory();
	const mismatches: string[] = [];
	const taken: { inner: InnerCall | null } = { inner: null };
	const workEnd = exportCallsOf(row.base).findLastIndex(
		(name) => name !== "mldsa_shake256_release",
	);
	const hook = painting((call, index) => {
		const proceeded = call.proceed();
		const reached =
			row.at === "the release" ? call.name === "mldsa_shake256_release" : index === workEnd;
		if (!reached || taken.inner !== null) {
			return proceeded;
		}
		mismatches.push(...inputsInPlace(row.base, call.memory));
		taken.inner = innerSign(row.base.objectName, hook);
		// A debugger can pause the outer call inside an export, which then goes
		// on writing after the inner call returns. The paint stands in for those
		// writes, so the row passes only if the outer call zeroes its instance
		// again.
		call.memory.fill(paint);
		return proceeded;
	});
	const result = runHooked(hook, () => invoke(row.base, unchanged));
	// Before the cleanup starts, the outer call puts nothing back, so the slot
	// keeps the inner call's instance.
	const { inner } = taken;
	if (row.at !== "the release" && inner !== null && currentMemory() !== inner.memory) {
		mismatches.push("The slot doesn't hold the inner call's instance.");
	}
	return [...mismatches, ...innerCallMismatches(row.base, held, result, inner, recording)];
}

function debuggerPauseMismatches(
	row: Extract<ListedRow, { kind: "public call from a debugger pause" }>,
	recording: boolean,
): readonly string[] {
	const held = slotMemory();
	const hook = painting(proceed);
	const taken: { inner: InnerCall | null } = { inner: null };
	const { value: result, paused } = pausedAt(
		row.point,
		() => {
			taken.inner = innerSign(row.base.objectName, hook);
			held.fill(paint);
		},
		() => runHooked(hook, () => invoke(row.base, unchanged)),
	);
	return [
		...(paused ? [] : ["The outer call never paused there."]),
		...innerCallMismatches(row.base, held, result, taken.inner, recording),
	];
}

/**
 * Runs `row` with the test record on or off, and returns its mismatches.
 * Every hook and switch is off again afterwards.
 */
export function rowMismatches(row: Row, recording: boolean): readonly string[] {
	setRecording(recording);
	try {
		return row.kind === "generated"
			? generatedMismatches(row, recording)
			: listedMismatches(row, recording);
	} finally {
		setExportHook(null);
		setRecording(false);
	}
}
