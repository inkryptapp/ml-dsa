// The globals and the module import that the package uses beyond
// `lib: ["es2024"]`. They stay out of the public declarations, which compile
// with `lib: ["es2024"]` and `types: []` alone.

declare namespace WebAssembly {
	class Module {
		constructor(bytes: Uint8Array<ArrayBuffer>);
	}

	class Instance {
		constructor(module: Module);
		// The package instantiates only its own module, whose export list the
		// tests pin.
		readonly exports: import("./module-exports.js").ModuleExports;
	}

	interface Memory {
		readonly buffer: ArrayBuffer;
	}

	// Every global that the module exports is an `i32`.
	interface Global {
		readonly value: number;
	}
}

declare function atob(data: string): string;

// A `.wasm` import gives the module's bytes as base64 text.
declare module "*.wasm" {
	const base64: string;
	export default base64;
}
