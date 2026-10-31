import { expect, test, vi } from "vite-plus/test";

// The two newest of the six getters. A runtime older than ES2024 lacks them.
test.each([
	["ArrayBuffer.prototype.resizable", "resizable"],
	["ArrayBuffer.prototype.detached", "detached"],
])("the import fails in a runtime without %s", async (getter, key) => {
	const descriptor = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, key);
	expect(descriptor?.get).toBeTypeOf("function");
	vi.resetModules();
	Reflect.deleteProperty(ArrayBuffer.prototype, key);
	try {
		await expect(import("../src/index.js")).rejects.toThrow(
			`ml-dsa: this runtime lacks the ${getter} getter, which the package needs to check its inputs.`,
		);
	} finally {
		if (descriptor !== undefined) {
			Reflect.defineProperty(ArrayBuffer.prototype, key, descriptor);
		}
	}
	vi.resetModules();
	await expect(import("../src/index.js")).resolves.toHaveProperty("mlDsa44");
});
