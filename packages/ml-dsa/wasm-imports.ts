/**
 * The plugins that give each entry the wasm module in its own form. The
 * default entry imports `wasm/mldsa.wasm` as base64 text, and the `workerd`
 * entry imports `wasm/mldsa.wasm?module` as a `WebAssembly.Module`.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { Plugin } from "vite";

const moduleSuffix = "?module";

/**
 * Loads each `.wasm` import as a module whose default export is the file's
 * bytes as base64 text. Vite treats a `.wasm` file as an asset, so the plugin
 * runs before Vite's own plugins.
 */
export function wasmBase64(): Plugin {
	return {
		name: "ml-dsa:wasm-base64",
		enforce: "pre",
		async load(id) {
			if (!id.endsWith(".wasm")) {
				return null;
			}
			const base64 = (await readFile(id)).toString("base64");
			return { code: `export default ${JSON.stringify(base64)};`, moduleType: "js" };
		},
	};
}

/**
 * Keeps each `.wasm?module` import as an import of the `.wasm` file next to
 * the output, and writes the file there unchanged. The Cloudflare Workers
 * toolchain gives such an import as a `WebAssembly.Module`.
 */
export function wasmModuleFile(): Plugin {
	return {
		name: "ml-dsa:wasm-module-file",
		async resolveId(source, importer) {
			if (!source.endsWith(`.wasm${moduleSuffix}`) || importer === undefined) {
				return null;
			}
			const file = resolve(dirname(importer), source.slice(0, -moduleSuffix.length));
			this.emitFile({ type: "asset", fileName: basename(file), source: await readFile(file) });
			return { id: `./${basename(file)}`, external: true };
		},
	};
}
