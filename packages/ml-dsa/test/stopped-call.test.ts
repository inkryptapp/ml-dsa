import vm from "node:vm";

import { afterEach, describe, expect, test } from "vite-plus/test";

import type { FunctionName } from "../src/module-exports.js";
import { parameterSets } from "../src/parameter-sets.js";
import { checkedOutMemory, currentMemory, layout, setExportHook } from "../src/testing.js";
import {
	firstDifference,
	freshMemoryMismatch,
	isAllZero,
	parameterSetCases,
	prototypeOf,
	regionOf,
	seedFrom,
	thrown,
} from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

/** Runs until the runtime stops the script that called it. */
function spin(): never {
	for (;;) {
		// A `vm` timeout stops the script at this loop's back edge.
	}
}

/** Runs `action` in a `vm` script that the runtime stops after 50 ms. */
function runStopped(action: () => unknown): void {
	const error = thrown(() =>
		vm.runInContext("action()", vm.createContext({ action }), { timeout: 50 }),
	);
	expect(error).toHaveProperty("code", "ERR_SCRIPT_EXECUTION_TIMEOUT");
}

/**
 * Runs `action` in a script that the runtime stops at the first export call
 * named `stopAt`, so none of the call's cleanup runs. Returns the memory of
 * the instance that the stopped call held.
 */
function stopCall(stopAt: FunctionName, action: () => unknown): Uint8Array<ArrayBuffer> {
	let stranded: Uint8Array<ArrayBuffer> | null = null;
	setExportHook((call) => {
		if (call.name === stopAt && stranded === null) {
			stranded = call.memory;
			spin();
		}
		return call.proceed();
	});
	runStopped(action);
	setExportHook(null);
	if (stranded === null) {
		throw new Error(`The call never reached ${stopAt}.`);
	}
	return stranded;
}

/** Whether the seed region of `memory` holds `seed`. */
function holdsSeed(memory: Uint8Array<ArrayBuffer>, seed: Uint8Array): boolean {
	const region = regionOf(memory, layout.regions.seed).subarray(0, seed.length);
	return firstDifference(region, seed) === null;
}

for (const { objectName, object, noble } of parameterSetCases) {
	describe(`a stopped ${objectName} call`, () => {
		const seed = seedFrom(80);
		const message = new Uint8Array([7, 8, 9]);
		const { publicKey, secretKey } = noble.keygen(seed);
		const signature = noble.sign(message, secretKey, { extraEntropy: false });
		const cases: readonly (readonly [string, FunctionName, () => unknown, unknown])[] = [
			[
				"in an export hook",
				parameterSets[objectName].keypairExport,
				() => object.keygen(seed),
				{ publicKey },
			],
			[
				"in a release hook inside finally",
				"mldsa_shake256_release",
				() => object.sign({ seed, message, randomness: "deterministic" }),
				signature,
			],
		];

		test.each(cases)(
			"%s strands memory that holds the seed, and the next call zeroes it and returns the reference output",
			(_, stopAt, action, expected) => {
				const stranded = stopCall(stopAt, action);
				expect(holdsSeed(stranded, seed)).toBe(true);
				expect(checkedOutMemory()).toBe(stranded);
				expect(currentMemory()).toBeNull();

				expect(action()).toStrictEqual(expected);
				expect(isAllZero(stranded)).toBe(true);
				expect(checkedOutMemory()).toBeNull();
				expect(currentMemory()).not.toBe(stranded);
				expect(freshMemoryMismatch()).toBeNull();
			},
		);

		test("leaves its memory alone during a call that fails its input checks", () => {
			const stranded = stopCall(parameterSets[objectName].keypairExport, () => object.keygen(seed));
			const error = thrown(() => object.keygen(new Uint8Array(new ArrayBuffer(31))));
			expect(prototypeOf(error)).toBe(RangeError.prototype);
			expect(holdsSeed(stranded, seed)).toBe(true);
			expect(checkedOutMemory()).toBe(stranded);

			expect(object.keygen(seed)).toStrictEqual({ publicKey });
			expect(isAllZero(stranded)).toBe(true);
		});

		test("inside another call leaves its own memory to the next call", () => {
			const innerSeed = seedFrom(81);
			let outer: Uint8Array | null = null;
			let stranded: Uint8Array<ArrayBuffer> | null = null;
			setExportHook((call) => {
				if (outer === null) {
					outer = call.memory;
					runStopped(() => object.keygen(innerSeed));
					// The inner call zeroed this instance, so the export doesn't run on it.
					return 0;
				}
				if (stranded === null) {
					stranded = call.memory;
					spin();
				}
				return call.proceed();
			});
			const error = thrown(() => object.keygen(seed));
			setExportHook(null);
			expect(prototypeOf(error)).toBe(Error.prototype);
			expect(outer === null ? false : isAllZero(outer)).toBe(true);
			if (stranded === null) {
				throw new Error("The inner call never reached its export call.");
			}
			expect(holdsSeed(stranded, innerSeed)).toBe(true);
			expect(checkedOutMemory()).toBe(stranded);

			expect(object.keygen(seed)).toStrictEqual({ publicKey });
			expect(isAllZero(stranded)).toBe(true);
			expect(checkedOutMemory()).toBeNull();
			expect(freshMemoryMismatch()).toBeNull();
		});
	});

	describe(`an inner ${objectName} call`, () => {
		const seed = seedFrom(82);
		const message = new Uint8Array([7, 8, 9]);
		const { publicKey } = noble.keygen(seed);

		test("that can't mark the outer call's instance lets the outer call finish", () => {
			// At the engine's stack limit, the mark's call can fail to start. A
			// throwing `add` stands in for that.
			const markError = new RangeError("mark");
			const add = Reflect.getOwnPropertyDescriptor(WeakSet.prototype, "add");
			let inner: unknown = null;
			setExportHook((call) => {
				if (inner === null && add !== undefined) {
					Reflect.defineProperty(WeakSet.prototype, "add", {
						...add,
						value: () => {
							throw markError;
						},
					});
					try {
						inner = thrown(() => object.sign({ seed, message, randomness: "deterministic" }));
					} finally {
						Reflect.defineProperty(WeakSet.prototype, "add", add);
					}
				}
				return call.proceed();
			});
			const outer = object.keygen(seed);
			setExportHook(null);
			expect(inner).toBe(markError);
			expect(outer).toStrictEqual({ publicKey });
			expect(checkedOutMemory()).toBeNull();
			expect(freshMemoryMismatch()).toBeNull();
		});
	});
}
