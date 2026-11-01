import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import {
	currentMemory,
	failNextCreation,
	layout,
	pointer,
	rawExports,
	setExportHook,
	type ExportCall,
} from "../src/testing.js";
import {
	firstDifference,
	freshMemoryMismatch,
	isAllZero,
	prototypeOf,
	regionOf,
	seedFrom,
	thrown,
	wipeAfterRawCall,
} from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

const seed = seedFrom(5);
const reference = { publicKey: ml_dsa44.keygen(seed).publicKey };

function isKeypair(call: ExportCall): boolean {
	return call.name.endsWith("_keypair_internal");
}

/** Expects the plain package `Error` that a failed `mlDsa44.keygen` call throws, with `cause`. */
function expectCallFailed(error: unknown, cause: unknown): void {
	expect(prototypeOf(error)).toBe(Error.prototype);
	expect(error).toHaveProperty("message", "mlDsa44.keygen: the call failed.");
	expect(error).toHaveProperty("cause", cause);
}

/** The live memory of the instance in the slot. Fails if the slot is empty. */
function liveMemory(): Uint8Array<ArrayBuffer> {
	const memory = currentMemory();
	if (memory === null) {
		throw new Error("The slot is empty.");
	}
	return memory;
}

/** Copies of an instance's seed and secret-key regions. */
interface SecretRegions {
	readonly seed: Uint8Array;
	readonly secretKey: Uint8Array;
}

/** Copies the seed and secret-key regions of the instance that `call` runs on. */
function regionsDuring(call: ExportCall): SecretRegions {
	return {
		seed: regionOf(call.memory, layout.regions.seed).slice(),
		secretKey: regionOf(call.memory, layout.regions.secretKey).slice(),
	};
}

describe("a non-zero upstream code", () => {
	test("wipes, keeps the instance, and throws a plain Error with { code } as the cause", () => {
		const before = liveMemory();
		setExportHook((call) => {
			const result = call.proceed();
			return isKeypair(call) ? 7 : result;
		});
		const error = thrown(() => mlDsa44.keygen(seed));
		expectCallFailed(error, { code: 7 });
		expect(currentMemory()).toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	});
});

describe("an exception while a call holds the instance", () => {
	test.each([
		[
			"a thrown error",
			"RangeError",
			(): never => {
				throw new RangeError("injected");
			},
		],
		[
			"a trap from the module",
			"RuntimeError",
			(call: ExportCall): void => {
				call.functions.mldsa_shake256_init(pointer(layout.memoryBytes));
			},
		],
	])("from %s zeroes the whole memory and drops the instance", (_, errorName, fault) => {
		const before = liveMemory();
		const seen: { regions?: SecretRegions; error?: unknown } = {};
		setExportHook((call) => {
			const result = call.proceed();
			seen.regions = regionsDuring(call);
			try {
				fault(call);
			} catch (error) {
				seen.error = error;
				throw error;
			}
			return result;
		});
		const error = thrown(() => mlDsa44.keygen(seed));
		setExportHook(null);

		// The fault came after keygen wrote its secrets, so the zeroing has
		// something to remove.
		expect(seen.regions?.seed).toStrictEqual(seed);
		expect(isAllZero(seen.regions?.secretKey ?? new Uint8Array(0))).toBe(false);
		expect(seen.error).toHaveProperty("name", errorName);

		expectCallFailed(error, seen.error);
		expect(isAllZero(before)).toBe(true);
		expect(currentMemory()).toBeNull();

		expect(mlDsa44.keygen(seed)).toStrictEqual(reference);
		expect(currentMemory()).not.toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	});
});

describe("a fill that throws during the cleanup", () => {
	/**
	 * Runs `action` while every `Uint8Array` fill throws `error`. The own
	 * property shadows the `fill` that `Uint8Array` inherits from
	 * `%TypedArray%.prototype`.
	 */
	function withThrowingFill(error: Error, action: () => unknown): unknown {
		Reflect.defineProperty(Uint8Array.prototype, "fill", {
			configurable: true,
			value: () => {
				throw error;
			},
		});
		try {
			return thrown(action);
		} finally {
			Reflect.deleteProperty(Uint8Array.prototype, "fill");
		}
	}

	test("poisons a healthy call, and the loop that calls no function zeroes the memory", () => {
		const before = liveMemory();
		const fillError = new RangeError("fill");
		const error = withThrowingFill(fillError, () => mlDsa44.keygen(seed));
		expectCallFailed(error, fillError);
		expect(isAllZero(before)).toBe(true);
		expect(currentMemory()).toBeNull();
		expect(mlDsa44.keygen(seed)).toStrictEqual(reference);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("keeps the first failure of a poisoned call as the cause", () => {
		const before = liveMemory();
		const injected = new RangeError("injected");
		setExportHook((call) => {
			call.proceed();
			throw injected;
		});
		const error = withThrowingFill(new RangeError("fill"), () => mlDsa44.keygen(seed));
		expectCallFailed(error, injected);
		expect(isAllZero(before)).toBe(true);
		expect(currentMemory()).toBeNull();
	});
});

describe("a failed instance creation after the import", () => {
	test("fails only its own call, and the next call creates an instance", () => {
		const injected = new Error("injected");
		failNextCreation(injected);
		const error = thrown(() => mlDsa44.keygen(seed));
		expectCallFailed(error, injected);
		expect(currentMemory()).toBeNull();

		expect(mlDsa44.keygen(seed)).toStrictEqual(reference);
		expect(freshMemoryMismatch()).toBeNull();
	});
});

describe("a healthy call", () => {
	test("zeroes the whole wasm stack and every byte from __heap_base", () => {
		const { stack } = layout;
		const paint = 0xa5;
		let painted = 0;
		setExportHook((call) => {
			call.memory.fill(paint, stack.start, stack.end);
			call.memory.fill(paint, layout.regions.seed.pointer + layout.regions.seed.length);
			painted += 1;
			return call.proceed();
		});
		expect(mlDsa44.keygen(seed)).toStrictEqual(reference);
		expect(painted).toBeGreaterThan(0);
		expect(freshMemoryMismatch()).toBeNull();
	});

	test("never writes the static data between the wasm stack and __heap_base", () => {
		const memory = liveMemory();
		const staticData = (): Uint8Array => memory.slice(layout.stack.end, layout.heapBase);
		const before = staticData();
		mlDsa44.keygen(seed);
		expect(freshMemoryMismatch()).toBeNull();
		expect(firstDifference(staticData(), before)).toBeNull();
		expect(isAllZero(before)).toBe(false);
	});
});

describe("the raw exports", () => {
	test("run the instance in the slot without the hook", () => {
		const raw = rawExports();
		const memory = liveMemory();
		let hooked = 0;
		setExportHook((call) => {
			hooked += 1;
			return call.proceed();
		});
		const { seed: seedRegion, publicKey, secretKey } = layout.regions;
		regionOf(memory, seedRegion).set(seed);
		const code = raw?.mldsa44_keypair_internal(
			publicKey.pointer,
			secretKey.pointer,
			seedRegion.pointer,
		);
		expect(code).toBe(0);
		expect(regionOf(memory, publicKey).slice(0, mlDsa44.lengths.publicKey)).toStrictEqual(
			reference.publicKey,
		);
		expect(hooked).toBe(0);

		wipeAfterRawCall(memory);
		expect(freshMemoryMismatch()).toBeNull();
	});
});
