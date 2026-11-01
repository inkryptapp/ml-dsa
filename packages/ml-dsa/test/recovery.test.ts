import { describe, expect, test } from "vite-plus/test";

import { currentMemory, layout, pointer, setExportHook } from "../src/testing.js";
import {
	freshMemoryMismatch,
	isAllZero,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
} from "./helpers.js";

for (const { objectName, object, noble } of parameterSetCases) {
	describe(`recovery after a trap in ${objectName}`, () => {
		const seed = seedFrom(90);
		const message = new Uint8Array([4, 5, 6]);
		const { publicKey, secretKey } = noble.keygen(seed);
		const signature = noble.sign(message, secretKey, { extraEntropy: false });

		test("zeroes the old memory, and the next keygen, sign, and verify return the known answers", () => {
			const old = currentMemory();
			const traps: unknown[] = [];
			setExportHook((call) => {
				try {
					// An out-of-bounds write past the end of memory traps in the module.
					call.functions.mldsa_shake256_init(pointer(layout.memoryBytes));
				} catch (error) {
					traps.push(error);
					throw error;
				}
				return call.proceed();
			});
			let error: unknown = undefined;
			try {
				error = thrown(() => object.keygen(seed));
			} finally {
				setExportHook(null);
			}

			expect(traps).toHaveLength(1);
			expect(traps[0]).toHaveProperty("name", "RuntimeError");
			expect(prototypeOf(error)).toBe(Error.prototype);
			expect(error).toHaveProperty("cause", traps[0]);
			expect(old === null ? false : isAllZero(old)).toBe(true);
			expect(currentMemory()).toBeNull();

			expect(object.keygen(seed)).toStrictEqual({ publicKey });
			expect(currentMemory()).not.toBe(old);
			expect(object.sign({ seed, message, randomness: "deterministic" })).toStrictEqual(signature);
			expect(object.verify({ publicKey, message, signature })).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});
	});
}
