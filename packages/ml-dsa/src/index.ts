/**
 * ML-DSA signatures from FIPS 204 for browsers, Web Workers, Cloudflare
 * Workers, and Node.js. One WebAssembly module, compiled from the mldsa-native
 * C library, holds ML-DSA-44, ML-DSA-65, and ML-DSA-87.
 *
 * The import compiles the module synchronously, so it needs no top-level
 * `await`. A runtime that can't compile it, such as a page whose Content
 * Security Policy lacks `'wasm-unsafe-eval'`, fails the import.
 *
 * @packageDocumentation
 */
export { mlDsa44, mlDsa65, mlDsa87 } from "./ml-dsa.js";

import wasmBase64 from "../wasm/mldsa.wasm";
import { initialize } from "./core.js";

// `Uint8Array.fromBase64` is missing from Node 22, Node 24, and Safari 17.4 to
// 18.1, so the bytes come from `atob`.
const binary = atob(wasmBase64);
const wasmBytes = new Uint8Array(binary.length);
for (let index = 0; index < binary.length; index += 1) {
	wasmBytes[index] = binary.charCodeAt(index);
}
initialize(new WebAssembly.Module(wasmBytes));
