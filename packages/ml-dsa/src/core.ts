// The shipped files import no JSON, so the bundler must inline this import.
import sizes from "../wasm/sizes.json" with { type: "json" };
import { pointer, type Pointer } from "./brand.js";
import * as messages from "./messages.js";
import type { Site } from "./messages.js";
import type { ModuleFunctions } from "./module-exports.js";
import { longest, seedBytes } from "./parameter-sets.js";

/** A run of linear memory that holds one input or output of a call. */
export interface Region {
	readonly pointer: Pointer;
	/** A view of exactly the region, so a longer copy throws instead of overrunning the next region. */
	readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * What the package keeps of one instance of the module: views of its memory,
 * the layout numbers, and the export functions. It never keeps the `Memory`
 * object, the exports object, or the instance, so no package code can detach
 * the memory's buffer.
 */
export interface Instance {
	readonly memory: Uint8Array<ArrayBuffer>;
	/** The whole memory as 32-bit words, for the fallback fill. */
	readonly words: Uint32Array<ArrayBuffer>;
	/** The length of `words`, because reading `words.length` calls a getter. */
	readonly wordCount: number;
	readonly stackLow: number;
	readonly stackHigh: number;
	readonly heapBase: number;
	readonly seed: Region;
	readonly publicKey: Region;
	readonly secretKey: Region;
	readonly functions: ModuleFunctions;
}

/** How a call's work on an instance ended. A non-zero upstream code isn't an exception. */
export type Outcome<Output> =
	| { readonly kind: "done"; readonly output: Output }
	| { readonly kind: "status"; readonly code: number };

let compiled: WebAssembly.Module | undefined = undefined;

// The instance that the next call runs on, or `null` if the next call must
// create one.
let slot: Instance | null = null;

/** Wraps the export functions of a new instance, for the test-only entry point's hooks. */
export type FunctionWrapper = (
	functions: ModuleFunctions,
	memory: Uint8Array<ArrayBuffer>,
) => ModuleFunctions;

let wrapFunctions: FunctionWrapper | null = null;

/**
 * Instantiates the compiled module, checks its geometry, and lays out the
 * regions from `__heap_base`. Tests also call it for an instance that no call
 * uses.
 */
export function createInstance(): Instance {
	if (compiled === undefined) {
		throw new Error(messages.noModule());
	}
	// The rest copies the function exports into an object of the package's
	// own, so the `Instance` keeps no reference to the exports object.
	const {
		memory: wasmMemory,
		__stack_low: stackLowGlobal,
		__stack_high: stackHighGlobal,
		__heap_base: heapBaseGlobal,
		__heap_end: heapEndGlobal,
		...exportedFunctions
	} = new WebAssembly.Instance(compiled).exports;
	const buffer = wasmMemory.buffer;
	const memoryBytes = buffer.byteLength;
	const stackLow = stackLowGlobal.value;
	const stackHigh = stackHighGlobal.value;
	const heapBase = heapBaseGlobal.value;
	const heapEnd = heapEndGlobal.value;
	// The link sets a fixed memory of the committed size that ends at
	// `__heap_end`, with the wasm stack first. The 32-bit view also needs a
	// length that is a multiple of 4.
	if (
		memoryBytes % 4 !== 0 ||
		memoryBytes !== sizes.memoryBytes ||
		heapEnd !== memoryBytes ||
		stackLow !== 0
	) {
		throw new Error(messages.badGeometry());
	}

	const seedAt = heapBase;
	const publicKeyAt = seedAt + seedBytes;
	const publicKeyBytes = longest("publicKey");
	const secretKeyAt = publicKeyAt + publicKeyBytes;
	const secretKeyBytes = longest("secretKey");
	if (secretKeyAt + secretKeyBytes > heapEnd) {
		throw new Error(messages.regionsOverflow());
	}
	const region = (at: number, length: number): Region =>
		Object.freeze({ pointer: pointer(at), bytes: new Uint8Array(buffer, at, length) });

	const functions: ModuleFunctions = Object.freeze(exportedFunctions);

	const memory = new Uint8Array(buffer);
	return Object.freeze({
		memory,
		words: new Uint32Array(buffer),
		wordCount: memoryBytes / 4,
		stackLow,
		stackHigh,
		heapBase,
		seed: region(seedAt, seedBytes),
		publicKey: region(publicKeyAt, publicKeyBytes),
		secretKey: region(secretKeyAt, secretKeyBytes),
		functions: wrapFunctions === null ? functions : wrapFunctions(functions, memory),
	});
}

/**
 * Takes the compiled module and creates the first instance. The default entry
 * calls it once while it evaluates, so a failure here fails the import.
 */
export function initialize(module: WebAssembly.Module): void {
	compiled = module;
	slot = createInstance();
}

/**
 * The instance in the slot, or a new one if the slot is empty. A failed
 * creation fails only this call, and the next call tries again.
 */
function instanceForCall(site: Site): Instance {
	if (slot !== null) {
		return slot;
	}
	try {
		return createInstance();
	} catch (cause) {
		throw new Error(messages.failed(site), { cause });
	}
}

/**
 * Runs one call's work on an instance and wipes the instance before it
 * returns or throws. Every call that uses the module runs through this
 * function.
 *
 * On a healthy exit, it zeroes the wasm stack and `[__heap_base, end of
 * memory)`, so memory then equals a fresh instance's memory, and it puts the
 * instance back. Any exception while it holds the instance poisons the
 * instance: it zeroes the whole memory and drops the instance, and the next
 * call creates a new one. A non-zero upstream code wipes, keeps the instance,
 * and throws with `{ code }` as the cause.
 *
 * @throws Error with the failure as `cause`, if creating an instance fails, the
 * work throws, a wipe step throws, or the work ends with a non-zero code.
 */
export function runCore<Output>(site: Site, work: (instance: Instance) => Outcome<Output>): Output {
	const instance = instanceForCall(site);
	slot = null;

	const { memory, words, wordCount, stackLow, stackHigh, heapBase } = instance;
	let outcome: Outcome<Output> | null = null;
	let poisoned = true;
	let failure: unknown = undefined;
	try {
		outcome = work(instance);
		poisoned = false;
	} catch (error) {
		failure = error;
	} finally {
		if (!poisoned) {
			try {
				memory.fill(0, stackLow, stackHigh);
				memory.fill(0, heapBase);
			} catch (error) {
				poisoned = true;
				failure = error;
			}
		}
		if (poisoned) {
			try {
				memory.fill(0);
			} catch {
				// The fallback calls no function, so it still runs when too
				// little engine stack is left for `fill`.
				for (let index = 0; index < wordCount; index += 1) {
					words[index] = 0;
				}
			}
		} else {
			slot = instance;
		}
	}

	// The error is built only after the cleanup, because building it can fail
	// at the engine's stack limit.
	if (poisoned || outcome === null) {
		throw new Error(messages.failed(site), { cause: failure });
	}
	if (outcome.kind === "status") {
		throw new Error(messages.failed(site), { cause: { code: outcome.code } });
	}
	return outcome.output;
}

/** Test-only: the instance in the slot, or `null` while a call holds it or after a drop. */
export function currentInstance(): Instance | null {
	return slot;
}

/**
 * Test-only: sets the function that wraps each new instance's export
 * functions, and puts a new instance in the slot.
 */
export function setFunctionWrapper(wrap: FunctionWrapper): void {
	wrapFunctions = wrap;
	slot = createInstance();
}

/** Test-only: empties the slot, so that the next call creates an instance. */
export function emptySlot(): void {
	slot = null;
}
