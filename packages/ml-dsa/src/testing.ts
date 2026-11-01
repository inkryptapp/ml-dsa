/**
 * The test-only entry point. It stays out of the package's `exports`, and it
 * shares the core and the instance slot with the public API, so a test that
 * imports both entries from the source sees the instances that the public API
 * uses. It adds hooks around every export call, snapshots of memory, and the
 * message representative that `verify` computes.
 *
 * @packageDocumentation
 */
// The default entry hands the compiled module to the core, which
// `createInstance` below needs.
import "./index.js";
import { pointer } from "./brand.js";
import { checkBytes, checkContext, checkExactBytes } from "./bytes.js";
import {
	createInstance,
	currentInstance,
	emptySlot,
	regionBytes,
	runCore,
	setFunctionWrapper,
	type Regions,
} from "./core.js";
import { writeVerifierMessageRepresentative } from "./message-representative.js";
import type { FunctionName, ModuleFunctions } from "./module-exports.js";
import { readOptions } from "./options.js";
import { parameterSets, type ObjectName } from "./parameter-sets.js";
import { publicKeyHashOffset } from "./upstream.js";

export { pointer };
export type { Region, Regions } from "./core.js";

/** One call from the package into a function export, as an {@link ExportHook} sees it. */
export interface ExportCall {
	/** The export's name. */
	readonly name: FunctionName;
	/** The whole memory of the instance that the call runs on. */
	readonly memory: Uint8Array<ArrayBuffer>;
	/** The instance's export functions, which no hook wraps. */
	readonly functions: ModuleFunctions;
	/** Runs the export with the package's arguments and returns its result. */
	proceed(): number | undefined;
}

/**
 * Runs in place of each export call while it is set, so a hook can paint
 * memory before it calls `proceed`, or throw. For an export that returns a
 * number, the package sees what the hook returns, which must be a number. For
 * the SHAKE256 procedures, the package ignores what the hook returns.
 */
export type ExportHook = (call: ExportCall) => number | undefined;

/** A range of memory offsets, from `start` up to but not including `end`. */
export interface Range {
	readonly start: number;
	readonly end: number;
}

/** Where the module and the package put things in linear memory. */
export interface Layout {
	readonly memoryBytes: number;
	/** The wasm stack, `[__stack_low, __stack_high)`. */
	readonly stack: Range;
	readonly heapBase: number;
	readonly regions: Regions;
	/** Where `sign` reads the public-key hash in a derived secret key. */
	readonly publicKeyHashOffset: number;
}

let hook: ExportHook | null = null;
let creationFailure: { readonly error: unknown } | null = null;

/** The parts of an instance that every {@link ExportCall} on it carries. */
interface HookedInstance {
	readonly memory: Uint8Array<ArrayBuffer>;
	readonly functions: ModuleFunctions;
}

// The export functions of every wrapped instance, keyed by its memory view.
const rawFunctions = new WeakMap<Uint8Array, ModuleFunctions>();

function withHook<Args extends readonly unknown[], Result>(
	name: FunctionName,
	run: (...args: Args) => Result,
	instance: HookedInstance,
	toResult: (hookResult: number | undefined) => Result,
): (...args: Args) => Result {
	return (...args) => {
		const current = hook;
		if (current === null) {
			return run(...args);
		}
		const proceed = (): number | undefined => {
			const result: unknown = run(...args);
			return typeof result === "number" ? result : undefined;
		};
		return toResult(current({ ...instance, name, proceed }));
	};
}

function wrap(functions: ModuleFunctions, memory: Uint8Array<ArrayBuffer>): ModuleFunctions {
	// The core calls the wrapper inside every creation, so a throw here fails
	// that creation.
	if (creationFailure !== null) {
		const { error } = creationFailure;
		creationFailure = null;
		throw error;
	}
	rawFunctions.set(memory, functions);
	const instance: HookedInstance = { memory, functions };
	const hookNumber = <Args extends readonly unknown[]>(
		name: FunctionName,
		run: (...args: Args) => number,
	): ((...args: Args) => number) =>
		withHook(name, run, instance, (result) => {
			if (typeof result !== "number") {
				throw new TypeError(`The export hook returned no number for ${name}.`);
			}
			return result;
		});
	const hookProcedure = <Args extends readonly unknown[]>(
		name: FunctionName,
		run: (...args: Args) => void,
	): ((...args: Args) => void) => withHook(name, run, instance, () => undefined);
	return Object.freeze({
		mldsa44_keypair_internal: hookNumber(
			"mldsa44_keypair_internal",
			functions.mldsa44_keypair_internal,
		),
		mldsa44_signature_internal: hookNumber(
			"mldsa44_signature_internal",
			functions.mldsa44_signature_internal,
		),
		mldsa44_verify_extmu: hookNumber("mldsa44_verify_extmu", functions.mldsa44_verify_extmu),
		mldsa65_keypair_internal: hookNumber(
			"mldsa65_keypair_internal",
			functions.mldsa65_keypair_internal,
		),
		mldsa65_signature_internal: hookNumber(
			"mldsa65_signature_internal",
			functions.mldsa65_signature_internal,
		),
		mldsa65_verify_extmu: hookNumber("mldsa65_verify_extmu", functions.mldsa65_verify_extmu),
		mldsa87_keypair_internal: hookNumber(
			"mldsa87_keypair_internal",
			functions.mldsa87_keypair_internal,
		),
		mldsa87_signature_internal: hookNumber(
			"mldsa87_signature_internal",
			functions.mldsa87_signature_internal,
		),
		mldsa87_verify_extmu: hookNumber("mldsa87_verify_extmu", functions.mldsa87_verify_extmu),
		mldsa44_prepare_domain_separation_prefix: hookNumber(
			"mldsa44_prepare_domain_separation_prefix",
			functions.mldsa44_prepare_domain_separation_prefix,
		),
		mldsa_shake256_init: hookProcedure("mldsa_shake256_init", functions.mldsa_shake256_init),
		mldsa_shake256_absorb: hookProcedure("mldsa_shake256_absorb", functions.mldsa_shake256_absorb),
		mldsa_shake256_finalize: hookProcedure(
			"mldsa_shake256_finalize",
			functions.mldsa_shake256_finalize,
		),
		mldsa_shake256_squeeze: hookProcedure(
			"mldsa_shake256_squeeze",
			functions.mldsa_shake256_squeeze,
		),
		mldsa_shake256_release: hookProcedure(
			"mldsa_shake256_release",
			functions.mldsa_shake256_release,
		),
	});
}

const fresh = createInstance();

/**
 * A copy of a fresh instance's whole memory. Between calls, the memory of the
 * instance in the slot must equal it byte for byte.
 */
export const freshMemory: Readonly<Uint8Array<ArrayBuffer>> = fresh.memory.slice();

function range(start: number, length: number): Range {
	return Object.freeze({ start, end: start + length });
}

/** The layout of every instance of the module. */
export const layout: Layout = Object.freeze({
	memoryBytes: fresh.memory.length,
	stack: range(fresh.stackLow, fresh.stackHigh - fresh.stackLow),
	heapBase: fresh.heapBase,
	regions: fresh.regions,
	publicKeyHashOffset,
});

// From here on, the slot and every new instance run their export calls
// through `hook`.
setFunctionWrapper(wrap);

/** Sets the hook that runs in place of each export call, or clears it with `null`. */
export function setExportHook(next: ExportHook | null): void {
	hook = next;
}

/**
 * Empties the slot and makes the next instance creation throw `error`, so the
 * next call fails while it creates its instance.
 */
export function failNextCreation(error: unknown): void {
	creationFailure = { error };
	emptySlot();
}

/**
 * The live memory of the instance in the slot, or `null` while the slot is
 * empty. The view's identity tells instances apart.
 */
export function currentMemory(): Uint8Array<ArrayBuffer> | null {
	return currentInstance()?.memory ?? null;
}

/**
 * The export functions of the instance in the slot, which no hook wraps, or
 * `null` while the slot is empty. A call through them changes that instance's
 * memory, so a test that makes one must restore the memory.
 */
export function rawExports(): ModuleFunctions | null {
	const memory = currentMemory();
	return memory === null ? null : (rawFunctions.get(memory) ?? null);
}

/** The named arguments of {@link messageRepresentative}. */
export interface MessageRepresentativeOptions {
	readonly publicKey: Uint8Array;
	readonly message: Uint8Array;
	readonly context?: Uint8Array | undefined;
}

const messageRepresentativeKeys = ["publicKey", "message", "context"] as const;

/**
 * The message representative that `verify` computes for a public key, a
 * message, and a context string. It runs the same read step, input checks,
 * core, and message-representative function as `verify`, and its errors name
 * the `verify` site.
 */
export function messageRepresentative(
	objectName: ObjectName,
	options: MessageRepresentativeOptions,
): Uint8Array<ArrayBuffer> {
	const site = `${objectName}.verify` as const;
	const values = readOptions(site, options, messageRepresentativeKeys);
	const publicKey = checkExactBytes(
		site,
		"publicKey",
		values.get("publicKey"),
		parameterSets[objectName].publicKey,
	);
	const message = checkBytes(site, "message", values.get("message"));
	const context = checkContext(site, values.get("context"));
	return runCore(site, (instance, initShake) => {
		const prefixStatus = writeVerifierMessageRepresentative(
			instance,
			initShake,
			publicKey,
			context,
			message,
		);
		if (prefixStatus !== null) {
			return prefixStatus;
		}
		return {
			kind: "done",
			output: regionBytes(instance, instance.regions.messageRepresentative).slice(),
		};
	});
}
