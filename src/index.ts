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
/** Length in bytes of an ML-DSA-87 signature. */
export const ML_DSA_87_SIGNATURE_BYTES = 4627;
/** Length in bytes of the Seed that {@link MlDsa87.keygen} derives a key pair from. */
export const ML_DSA_87_SEED_BYTES = 32;
/** Length in bytes of the Signing randomness that {@link MlDsa87.sign} takes. */
export const ML_DSA_87_RND_BYTES = 32;
/** The longest Context, in bytes, that FIPS 204 allows. */
export const ML_DSA_87_MAX_CONTEXT_BYTES = 255;

/** A key pair from {@link MlDsa87.keygen}. Both arrays are fresh copies that later calls never change. */
export interface MlDsa87KeyPair {
  /** The FIPS 204 encoding of the verification key, {@link ML_DSA_87_PUBLIC_KEY_BYTES} bytes long. */
  publicKey: Uint8Array;
  /** The FIPS 204 encoding of the signing key, {@link ML_DSA_87_SECRET_KEY_BYTES} bytes long. */
  secretKey: Uint8Array;
}

/** Named arguments for {@link MlDsa87.sign}. */
export interface MlDsa87SignArgs {
  /** The Secret key from {@link MlDsa87.keygen}, {@link ML_DSA_87_SECRET_KEY_BYTES} bytes long. */
  secretKey: Uint8Array;
  /** The message to sign, of any length. */
  message: Uint8Array;
  /**
   * The Context bound into the signature, at most {@link ML_DSA_87_MAX_CONTEXT_BYTES} bytes long. The signature
   * verifies only under the same Context.
   *
   * @defaultValue An empty Context.
   */
  context?: Uint8Array;
  /**
   * The Signing randomness, {@link ML_DSA_87_RND_BYTES} bytes long. Pass fresh bytes from a CSPRNG for Hedged
   * signing, or 32 zero bytes for Deterministic signing.
   */
  rnd: Uint8Array;
}

/** Named arguments for {@link MlDsa87.verify}. */
export interface MlDsa87VerifyArgs {
  /** The signer's Public key. */
  publicKey: Uint8Array;
  /** The signed message. */
  message: Uint8Array;
  /**
   * The Context the message was signed under.
   *
   * @defaultValue An empty Context.
   */
  context?: Uint8Array;
  /** The signature to check. */
  signature: Uint8Array;
}

/** ML-DSA-87 operations on one loaded module. Get it from {@link loadMlDsa87}. */
export interface MlDsa87 {
  /**
   * Derives the Public key and Secret key from a Seed. The same Seed always gives the same key pair.
   *
   * The package draws no randomness, so draw the Seed from a CSPRNG such as `crypto.getRandomValues`.
   *
   * @throws TypeError if `seed` isn't a `Uint8Array`.
   * @throws RangeError if `seed` isn't exactly {@link ML_DSA_87_SEED_BYTES} bytes long.
   * @throws Error if mldsa-native reports a failure. Its `cause` is `{ code }`, holding mldsa-native's return code.
   */
  keygen(seed: Uint8Array): MlDsa87KeyPair;
  /**
   * Signs `message` under `context` with pure ML-DSA-87 and returns a fresh {@link ML_DSA_87_SIGNATURE_BYTES}-byte
   * signature. The same arguments always give the same signature.
   *
   * @throws TypeError if `args` isn't an object, or if one of its fields isn't a `Uint8Array`.
   * @throws RangeError if `secretKey` or `rnd` has the wrong length, if `context` is longer than
   * {@link ML_DSA_87_MAX_CONTEXT_BYTES} bytes, or if the module's memory can't grow to hold `message`.
   * @throws Error if mldsa-native reports a failure. Its `cause` is `{ code }`, holding mldsa-native's return code.
   */
  sign(args: MlDsa87SignArgs): Uint8Array;
  /**
   * Checks whether `signature` is a valid ML-DSA-87 signature of `message` under `context` for `publicKey`.
   *
   * Returns `false`, and never throws, for any argument it can't use. That includes a missing argument object, a
   * field that isn't a `Uint8Array`, a key or signature of the wrong length, a Context longer than
   * {@link ML_DSA_87_MAX_CONTEXT_BYTES} bytes, and a message too large for the module's memory.
   */
  verify(args: MlDsa87VerifyArgs): boolean;
}

/** The module's exports, checked once at load. */
interface Exports {
  memory: WebAssembly.Memory;
  heapBase: number;
  keygen: (publicKey: number, secretKey: number, seed: number) => unknown;
  sign: (
    signature: number,
    message: number,
    messageLength: number,
    context: number,
    contextLength: number,
    rnd: number,
    secretKey: number,
  ) => unknown;
  verify: (
    signature: number,
    message: number,
    messageLength: number,
    context: number,
    contextLength: number,
    publicKey: number,
  ) => unknown;
}

const PAGE_BYTES = 65536;
const EMPTY = new Uint8Array(0);

// The engine's own length getter for typed arrays. `Uint8Array.prototype.set` copies the real length, so a length
// read through `bytes.length`, which an own property or a subclass getter can fake, could disagree with what's copied.
const intrinsicLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length",
)?.get;

function lengthOf(bytes: Uint8Array): number {
  if (intrinsicLength === undefined) {
    throw new Error("this runtime has no TypedArray length getter");
  }
  return intrinsicLength.call(bytes);
}

/**
 * Why `value` can't be used as the named argument, or `undefined` when it can. keygen and sign throw the error, and
 * verify answers `false`.
 */
function invalidBytes(
  name: string,
  value: unknown,
  length?: number | { max: number },
): TypeError | RangeError | undefined {
  if (!(value instanceof Uint8Array)) {
    return new TypeError(`${name} must be a Uint8Array`);
  }
  if (length === undefined) {
    return undefined;
  }
  const actual = lengthOf(value);
  if (typeof length === "number") {
    return actual === length ? undefined : new RangeError(`${name} must be ${length} bytes, got ${actual}`);
  }
  return actual <= length.max
    ? undefined
    : new RangeError(`${name} must be at most ${length.max} bytes, got ${actual}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
 * const message = new TextEncoder().encode("hello");
 * const rnd = crypto.getRandomValues(new Uint8Array(ML_DSA_87_RND_BYTES));
 * const signature = mlDsa.sign({ secretKey, message, rnd });
 * mlDsa.verify({ publicKey, message, signature }); // true
 * ```
 */
export async function loadMlDsa87(): Promise<MlDsa87> {
  const { instance } = await WebAssembly.instantiate(decodeBase64(MLDSA87_WASM_BASE64), {});
  return createMlDsa87(parseExports(instance.exports));
}

function createMlDsa87({ memory, heapBase, keygen, sign, verify }: Exports): MlDsa87 {
  // Fixed regions above the heap base, then the message, which may grow the memory. The module has no C
  // allocator.
  const publicKeyAt = heapBase;
  const secretKeyAt = publicKeyAt + ML_DSA_87_PUBLIC_KEY_BYTES;
  const signatureAt = secretKeyAt + ML_DSA_87_SECRET_KEY_BYTES;
  const seedAt = signatureAt + ML_DSA_87_SIGNATURE_BYTES;
  const rndAt = seedAt + ML_DSA_87_SEED_BYTES;
  const contextAt = rndAt + ML_DSA_87_RND_BYTES;
  const messageAt = contextAt + ML_DSA_87_MAX_CONTEXT_BYTES;

  /** A view of the whole memory once it holds `end` bytes. Growing detaches the old buffer, so views never outlive a call. */
  function viewTo(end: number): Uint8Array {
    if (end > memory.buffer.byteLength) {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / PAGE_BYTES));
    }
    return new Uint8Array(memory.buffer);
  }

  return {
    keygen(seed) {
      const invalid = invalidBytes("seed", seed, ML_DSA_87_SEED_BYTES);
      if (invalid !== undefined) {
        throw invalid;
      }
      const view = viewTo(messageAt);
      view.set(seed, seedAt);
      const code = keygen(publicKeyAt, secretKeyAt, seedAt);
      if (code !== 0) {
        throw new Error("mldsa-native keygen failed", { cause: { code } });
      }
      return {
        publicKey: view.slice(publicKeyAt, publicKeyAt + ML_DSA_87_PUBLIC_KEY_BYTES),
        secretKey: view.slice(secretKeyAt, secretKeyAt + ML_DSA_87_SECRET_KEY_BYTES),
      };
    },

    sign(args) {
      if (!isObject(args)) {
        throw new TypeError("sign takes an object of named arguments");
      }
      const { secretKey, message, context = EMPTY, rnd } = args;
      const invalid =
        invalidBytes("secretKey", secretKey, ML_DSA_87_SECRET_KEY_BYTES) ??
        invalidBytes("message", message) ??
        invalidBytes("context", context, { max: ML_DSA_87_MAX_CONTEXT_BYTES }) ??
        invalidBytes("rnd", rnd, ML_DSA_87_RND_BYTES);
      if (invalid !== undefined) {
        throw invalid;
      }
      const messageLength = lengthOf(message);
      const view = viewTo(messageAt + messageLength);
      view.set(message, messageAt);
      view.set(context, contextAt);
      view.set(rnd, rndAt);
      view.set(secretKey, secretKeyAt);
      const code = sign(
        signatureAt,
        messageAt,
        messageLength,
        contextAt,
        lengthOf(context),
        rndAt,
        secretKeyAt,
      );
      if (code !== 0) {
        throw new Error("mldsa-native sign failed", { cause: { code } });
      }
      return view.slice(signatureAt, signatureAt + ML_DSA_87_SIGNATURE_BYTES);
    },

    verify(args) {
      // Anything verify can't check is not a valid signature: a hostile argument object, or a message too large
      // for the memory to grow to, answers false like a wrong length does.
      try {
        if (!isObject(args)) {
          return false;
        }
        const { publicKey, message, context = EMPTY, signature } = args;
        const invalid =
          invalidBytes("publicKey", publicKey, ML_DSA_87_PUBLIC_KEY_BYTES) ??
          invalidBytes("message", message) ??
          invalidBytes("context", context, { max: ML_DSA_87_MAX_CONTEXT_BYTES }) ??
          invalidBytes("signature", signature, ML_DSA_87_SIGNATURE_BYTES);
        if (invalid !== undefined) {
          return false;
        }
        const messageLength = lengthOf(message);
        const view = viewTo(messageAt + messageLength);
        view.set(message, messageAt);
        view.set(context, contextAt);
        view.set(signature, signatureAt);
        view.set(publicKey, publicKeyAt);
        return verify(signatureAt, messageAt, messageLength, contextAt, lengthOf(context), publicKeyAt) === 0;
      } catch {
        return false;
      }
    },
  };
}

function parseExports(exports: WebAssembly.Exports): Exports {
  const {
    memory,
    __heap_base: heapBase,
    mldsa87_keygen: keygen,
    mldsa87_sign: sign,
    mldsa87_verify: verify,
  } = exports;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("module exports no memory");
  }
  if (!(heapBase instanceof WebAssembly.Global) || typeof heapBase.value !== "number") {
    throw new Error("module exports no __heap_base");
  }
  if (typeof keygen !== "function") {
    throw new Error("module exports no mldsa87_keygen");
  }
  if (typeof sign !== "function") {
    throw new Error("module exports no mldsa87_sign");
  }
  if (typeof verify !== "function") {
    throw new Error("module exports no mldsa87_verify");
  }
  return {
    memory,
    heapBase: heapBase.value,
    keygen: (...args) => keygen(...args),
    sign: (...args) => sign(...args),
    verify: (...args) => verify(...args),
  };
}
