/**
 * The `workerd` entry, which Cloudflare Workers resolve through the `workerd`
 * export condition. It exports the same API as the default entry. Cloudflare
 * documents only precompiled wasm modules, so this entry imports the raw
 * `.wasm` file, which the Cloudflare Workers toolchain gives as a
 * `WebAssembly.Module`.
 *
 * @packageDocumentation
 */
export { mlDsa44, mlDsa65, mlDsa87 } from "./ml-dsa.js";

import compiled from "../wasm/mldsa.wasm?module";
import { initialize } from "./core.js";

initialize(compiled);
