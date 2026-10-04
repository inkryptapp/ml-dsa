/**
 * ML-DSA-87 (FIPS 204) from mldsa-native, compiled to WebAssembly. Load the module once with {@link loadMlDsa87},
 * then call its operations synchronously.
 *
 * @packageDocumentation
 */
export {
  ML_DSA_87_MAX_CONTEXT_BYTES,
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_RND_BYTES,
  ML_DSA_87_SECRET_KEY_BYTES,
  ML_DSA_87_SEED_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
  type MlDsa87,
  type MlDsa87KeyPair,
  type MlDsa87SignArgs,
  type MlDsa87VerifyArgs,
  loadMlDsa87,
} from "./mldsa87.js";
