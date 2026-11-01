import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import { currentMemory, layout, rawExports, setExportHook } from "../src/testing.js";
import {
	firstDifference,
	freshMemoryMismatch,
	isAllZero,
	regionOf,
	seedFrom,
	wipeAfterRawCall,
} from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

const seed = seedFrom(5);
const reference = { publicKey: ml_dsa44.keygen(seed).publicKey };

/** The live memory of the instance in the slot. Fails if the slot is empty. */
function liveMemory(): Uint8Array<ArrayBuffer> {
	const memory = currentMemory();
	if (memory === null) {
		throw new Error("The slot is empty.");
	}
	return memory;
}

describe("a healthy call", () => {
	test("never writes the static data between the wasm stack and __heap_base", () => {
		const memory = liveMemory();
		const staticData = (): Uint8Array => memory.slice(layout.stack.end, layout.heapBase);
		const before = staticData();
		expect(mlDsa44.keygen(seed)).toStrictEqual(reference);
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
