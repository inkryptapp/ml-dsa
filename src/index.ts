/**
 * ML-DSA-87 (FIPS 204) from mldsa-native, compiled to WebAssembly. Load the module once with {@link loadMlDsa87},
 * then call its operations synchronously.
 *
 * @packageDocumentation
 */
import { decodeBase64 } from "./base64.js";
import { MLDSA87_WASM_BASE64 } from "./mldsa87-wasm.js";

/** Length in bytes of an ML-DSA-87 Public key. */
export const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;
/** Length in bytes of an ML-DSA-87 Secret key. */
export const ML_DSA_87_SECRET_KEY_BYTES = 4896;
/** Length in bytes of the Seed that {@link MlDsa87.keygen} derives a key pair from. */
export const ML_DSA_87_SEED_BYTES = 32;

/** A key pair from {@link MlDsa87.keygen}. Both arrays are fresh copies that later calls never change. */
export interface MlDsa87KeyPair {
  /** The FIPS 204 encoding of the verification key, {@link ML_DSA_87_PUBLIC_KEY_BYTES} bytes long. */
  publicKey: Uint8Array;
  /** The FIPS 204 encoding of the signing key, {@link ML_DSA_87_SECRET_KEY_BYTES} bytes long. */
  secretKey: Uint8Array;
}

/** ML-DSA-87 operations on one loaded module. Get it from {@link loadMlDsa87}. */
export interface MlDsa87 {
  /**
   * Derives the Public key and Secret key from a Seed. The same Seed always gives the same key pair.
   *
   * The package draws no randomness, so draw the Seed from a CSPRNG such as `crypto.getRandomValues`.
   *
   * @throws TypeError if `seed` isn't a `Uint8Array`.
   * @throws RangeError if `seed.length` isn't {@link ML_DSA_87_SEED_BYTES}.
   * @throws Error if mldsa-native reports a failure. Its `cause` is `{ code }`, holding mldsa-native's return code.
   */
  keygen(seed: Uint8Array): MlDsa87KeyPair;
}

/** The module's exports, checked once at load. */
interface Exports {
  memory: WebAssembly.Memory;
  heapBase: number;
  keygen: (publicKey: number, secretKey: number, seed: number) => unknown;
}

const PAGE_BYTES = 65536;

/**
 * Compiles and instantiates the WebAssembly module embedded in the package. Loading makes no network request.
 *
 * @throws Rejects if the runtime can't compile WebAssembly, for example under a Content Security Policy that lacks
 * `'wasm-unsafe-eval'`.
 *
 * @example
 * ```ts
 * const mlDsa = await loadMlDsa87();
 * const { publicKey, secretKey } = mlDsa.keygen(crypto.getRandomValues(new Uint8Array(ML_DSA_87_SEED_BYTES)));
 * ```
 */
export async function loadMlDsa87(): Promise<MlDsa87> {
  const { instance } = await WebAssembly.instantiate(decodeBase64(MLDSA87_WASM_BASE64), {});
  return createMlDsa87(parseExports(instance.exports));
}

function createMlDsa87({ memory, heapBase, keygen }: Exports): MlDsa87 {
  // Fixed regions above the heap base. The module has no C allocator.
  const publicKeyAt = heapBase;
  const secretKeyAt = publicKeyAt + ML_DSA_87_PUBLIC_KEY_BYTES;
  const seedAt = secretKeyAt + ML_DSA_87_SECRET_KEY_BYTES;
  const end = seedAt + ML_DSA_87_SEED_BYTES;
  if (end > memory.buffer.byteLength) {
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / PAGE_BYTES));
  }

  return {
    keygen(seed) {
      if (!(seed instanceof Uint8Array)) throw new TypeError("seed must be a Uint8Array");
      if (seed.length !== ML_DSA_87_SEED_BYTES) {
        throw new RangeError(`seed must be ${ML_DSA_87_SEED_BYTES} bytes, got ${seed.length}`);
      }
      const view = new Uint8Array(memory.buffer);
      view.set(seed, seedAt);
      const code = keygen(publicKeyAt, secretKeyAt, seedAt);
      if (code !== 0) throw new Error("mldsa-native keygen failed", { cause: { code } });
      return {
        publicKey: view.slice(publicKeyAt, publicKeyAt + ML_DSA_87_PUBLIC_KEY_BYTES),
        secretKey: view.slice(secretKeyAt, secretKeyAt + ML_DSA_87_SECRET_KEY_BYTES),
      };
    },
  };
}

function parseExports(exports: WebAssembly.Exports): Exports {
  const { memory, __heap_base: heapBase, mldsa87_keygen: keygen } = exports;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("module exports no memory");
  if (!(heapBase instanceof WebAssembly.Global) || typeof heapBase.value !== "number") {
    throw new Error("module exports no __heap_base");
  }
  if (typeof keygen !== "function") throw new Error("module exports no mldsa87_keygen");
  return { memory, heapBase: heapBase.value, keygen: (...args) => keygen(...args) };
}
