/**
 * The files that several of the wasm port's checks read or name, relative to
 * the repo root.
 */
import { ctActionPath, ctWorkflowPath } from "../../../scripts/ct-matrix.ts";
import { submodulePath } from "../../../scripts/pin-guard.ts";

/** The committed wasm module. */
export const moduleFile = "packages/ml-dsa/wasm/mldsa.wasm";

/** The build script, which holds every compiler and linker flag. */
export const buildScript = "packages/ml-dsa/wasm/build.sh";

/** Upstream's CT workflow at the pin, whose matrix the toolchain match reads. */
export const ctWorkflowFile = `${submodulePath}/${ctWorkflowPath}`;

/** Upstream's CT action at the pin, which adds definitions to every CT step. */
export const ctActionFile = `${submodulePath}/${ctActionPath}`;
