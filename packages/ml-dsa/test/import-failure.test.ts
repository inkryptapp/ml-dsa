// A test file of its own, because a failed import stays failed in the file's
// module graph. Each case starts from a new module graph.

import { beforeEach, expect, test, vi } from "vite-plus/test";

beforeEach(() => {
	vi.resetModules();
});

test.each([
	["compiling the module", "Module"],
	["creating the first instance", "Instance"],
] as const)(
	"keeps a failed import failed in its realm, with the same error, when %s fails",
	async (_, constructorName) => {
		const injected = new Error(`injected ${constructorName} failure`);
		const real = Reflect.getOwnPropertyDescriptor(WebAssembly, constructorName);
		Reflect.defineProperty(WebAssembly, constructorName, {
			configurable: true,
			writable: true,
			value: function Failing() {
				throw injected;
			},
		});
		let first: unknown = undefined;
		try {
			await import("../src/index.js");
		} catch (error) {
			first = error;
		} finally {
			if (real !== undefined) {
				Reflect.defineProperty(WebAssembly, constructorName, real);
			}
		}
		expect(first).toBe(injected);
		// The step would now succeed, but the module stays errored.
		await expect(import("../src/index.js")).rejects.toBe(injected);
	},
);
