import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { root } from "./dev-tools.js";

interface Descriptor {
	readonly name: string;
	readonly kind: string;
}

// Neither `lib: ["es2024"]` nor `@types/node` declares `WebAssembly`, so the
// test declares the part that it calls.
declare const WebAssembly: {
	readonly Module: {
		new (bytes: Uint8Array): object;
		exports(module: object): Descriptor[];
		imports(module: object): Descriptor[];
	};
};

function committedModule(): object {
	return new WebAssembly.Module(readFileSync(join(root, "packages/ml-dsa/wasm/mldsa.wasm")));
}

test("the committed wasm module imports nothing", () => {
	expect(WebAssembly.Module.imports(committedModule())).toStrictEqual([]);
});

test("the committed wasm module exports exactly its 20 symbols", () => {
	const byName = (a: Descriptor, b: Descriptor): number => a.name.localeCompare(b.name);
	expect(WebAssembly.Module.exports(committedModule()).toSorted(byName)).toStrictEqual(
		[
			{ name: "memory", kind: "memory" },
			{ name: "__stack_low", kind: "global" },
			{ name: "__stack_high", kind: "global" },
			{ name: "__heap_base", kind: "global" },
			{ name: "__heap_end", kind: "global" },
			{ name: "mldsa44_keypair_internal", kind: "function" },
			{ name: "mldsa44_signature_internal", kind: "function" },
			{ name: "mldsa44_verify_extmu", kind: "function" },
			{ name: "mldsa65_keypair_internal", kind: "function" },
			{ name: "mldsa65_signature_internal", kind: "function" },
			{ name: "mldsa65_verify_extmu", kind: "function" },
			{ name: "mldsa87_keypair_internal", kind: "function" },
			{ name: "mldsa87_signature_internal", kind: "function" },
			{ name: "mldsa87_verify_extmu", kind: "function" },
			{ name: "mldsa44_prepare_domain_separation_prefix", kind: "function" },
			{ name: "mldsa_shake256_init", kind: "function" },
			{ name: "mldsa_shake256_absorb", kind: "function" },
			{ name: "mldsa_shake256_finalize", kind: "function" },
			{ name: "mldsa_shake256_squeeze", kind: "function" },
			{ name: "mldsa_shake256_release", kind: "function" },
		].toSorted(byName),
	);
});
