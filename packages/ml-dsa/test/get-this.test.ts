import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import { currentMemory, layout, pointer, setExportHook } from "../src/testing.js";
import { isAllZero, prototypeOf, seedFrom, thrown } from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

/** The whole memory of `value` if it is a `WebAssembly.Instance`, or `null`. */
function instanceMemory(value: unknown): Uint8Array<ArrayBuffer> | null {
	if (prototypeOf(value) !== WebAssembly.Instance.prototype) {
		return null;
	}
	const memory: unknown = Reflect.get(Reflect.get(Object(value), "exports"), "memory");
	const buffer: unknown =
		typeof memory === "object" && memory !== null ? Reflect.get(memory, "buffer") : null;
	return isArrayBuffer(buffer) ? new Uint8Array(buffer) : null;
}

describe("V8's getThis() on the call sites of a trap", () => {
	test("reaches the dropped instance, which isn't the current one and whose whole memory reads zero", () => {
		const seed = seedFrom(95);
		const real = Reflect.getOwnPropertyDescriptor(Error, "prepareStackTrace");
		let trap: unknown = undefined;
		let callSites: readonly NodeJS.CallSite[] = [];
		try {
			Error.prepareStackTrace = (error, sites) => {
				if (error === trap) {
					callSites = sites;
				}
				return "";
			};
			setExportHook((call) => {
				try {
					// An out-of-bounds write past the end of memory traps in the module.
					call.functions.mldsa_shake256_init(pointer(layout.memoryBytes));
				} catch (error) {
					trap = error;
				}
				throw trap;
			});
			thrown(() => mlDsa44.keygen(seed));
			// V8 builds the stack, and so calls `prepareStackTrace`, on the first read.
			Reflect.get(Object(trap), "stack");
		} finally {
			if (real === undefined) {
				Reflect.deleteProperty(Error, "prepareStackTrace");
			} else {
				Reflect.defineProperty(Error, "prepareStackTrace", real);
			}
			setExportHook(null);
		}

		const dropped = callSites
			.map((site) => instanceMemory(site.getThis()))
			.filter((memory) => memory !== null);
		expect(dropped).toHaveLength(1);
		expect(mlDsa44.keygen(seed)).toStrictEqual({ publicKey: ml_dsa44.keygen(seed).publicKey });
		const [memory] = dropped;
		expect(memory?.buffer).not.toBe(currentMemory()?.buffer);
		expect(memory?.length).toBe(layout.memoryBytes);
		expect(memory !== undefined && isAllZero(memory)).toBe(true);
	});
});
