# @inkrypt/ml-dsa

ML-DSA-87 ([FIPS 204](https://csrc.nist.gov/pubs/fips/204/final)) for browsers, Workers and Node. It runs [mldsa-native](https://github.com/pq-code-package/mldsa-native), compiled to a single WebAssembly module and embedded in a plain ES module.

- Every output is byte-identical to the Oracle's for the same inputs. The Oracle is [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) 0.7.1 `ml_dsa87`, the pure-JavaScript implementation the tests compare against.
- `verify` answers `false`, never throws, for any input it can't use.
- The package draws no randomness. You pass the Seed and the Signing randomness in.
- Secrets copied into the module's memory are wiped before each call returns or throws.
- The module rebuilds byte for byte from source. See [Rebuild the module and compare hashes](#rebuild-the-module-and-compare-hashes).

## Install

```sh
npm install @inkrypt/ml-dsa
```

The package is ESM only and has no dependencies. It needs no bundler configuration and makes no network requests: the module's bytes are in `dist/mldsa87-wasm.js`.

## Usage

Load the module once, then call the operations synchronously:

```ts
import { ML_DSA_87_RND_BYTES, ML_DSA_87_SEED_BYTES, loadMlDsa87 } from "@inkrypt/ml-dsa";

const mlDsa = await loadMlDsa87();

const seed = crypto.getRandomValues(new Uint8Array(ML_DSA_87_SEED_BYTES));
const { publicKey, secretKey } = mlDsa.keygen(seed);

const message = new TextEncoder().encode("hello");
const context = new TextEncoder().encode("example/v1");
const rnd = crypto.getRandomValues(new Uint8Array(ML_DSA_87_RND_BYTES));
const signature = mlDsa.sign({ secretKey, message, context, rnd });

mlDsa.verify({ publicKey, message, context, signature }); // true
```

### `loadMlDsa87(): Promise<MlDsa87>`

Instantiates the embedded module and returns the operations. Every call in the same realm (a page, a Worker or a Node process) returns the same instance. If loading fails, the failure isn't kept, so the next call tries again.

### `keygen(seed): { publicKey, secretKey }`

Derives the key pair from a 32-byte Seed. The Public key is 2592 bytes and the Secret key is 4896 bytes, both in FIPS 204's encoding. The same Seed always gives the same keys.

### `sign({ secretKey, message, context?, rnd }): Uint8Array`

Signs `message` with pure ML-DSA-87 and returns a 4627-byte signature.

- `message` may be any length the module's memory can grow to hold. wasm32 memory stops at 4 GiB, and some engines stop sooner.
- `context` is bound into the signature, and the signature verifies only under the same Context. It is at most 255 bytes, and empty when omitted. It must be a `Uint8Array`; strings are rejected, so a text encoding can't change which Context you sign under.
- `rnd` is the 32-byte Signing randomness. Pass fresh bytes from a CSPRNG for Hedged signing, or 32 zero bytes for Deterministic signing. There is no separate deterministic mode.

### `verify({ publicKey, message, context?, signature }): boolean`

Returns whether `signature` is valid for `message` under `context`. `context` is empty when omitted. It returns `false`, and never throws, for any argument it can't use: a wrong type, a wrong length, a Context over 255 bytes, a truncated or extended signature, or a missing argument object.

### Errors

`keygen` and `sign` check every argument before the module runs:

- `TypeError` when an argument isn't a `Uint8Array`, or `sign` gets no argument object.
- `RangeError` when an argument has the wrong length, a Context is over 255 bytes, or a message is too large for the module's memory to grow to.
- `Error`, with `cause: { code }` holding mldsa-native's return code, if the C library reports a failure. No input is known to cause one.

### Returned arrays

Keys and signatures are fresh `Uint8Array`s that you own. Later calls never change them.

### Constants

| Constant                      | Value |
| ----------------------------- | ----- |
| `ML_DSA_87_PUBLIC_KEY_BYTES`  | 2592  |
| `ML_DSA_87_SECRET_KEY_BYTES`  | 4896  |
| `ML_DSA_87_SIGNATURE_BYTES`   | 4627  |
| `ML_DSA_87_SEED_BYTES`        | 32    |
| `ML_DSA_87_RND_BYTES`         | 32    |
| `ML_DSA_87_MAX_CONTEXT_BYTES` | 255   |

## Your duty: randomness

The package never draws randomness, and the module imports none (see [ADR 0003](docs/adr/0003-randomness-enters-as-arguments.md)). You draw it:

- Draw every Seed and every Signing randomness from a CSPRNG: `crypto.getRandomValues` in browsers, Workers and Node.
- Draw fresh Signing randomness for every Hedged `sign` call. Never reuse it.
- For Deterministic signing, pass 32 zero bytes as `rnd`: `new Uint8Array(32)`.

A Seed is as secret as the Secret key it derives. If you store Seeds, call `keygen` once and keep the Secret key in memory.

## Content Security Policy

The package compiles WebAssembly from bytes, so a page with a Content Security Policy must allow `'wasm-unsafe-eval'` in `script-src`:

```
Content-Security-Policy: script-src 'self' 'wasm-unsafe-eval'
```

## Supported runtimes

- **Node** 22 and later. The suite runs on Node 22 and Node 24.
- **Browsers:** the last two major versions of Chrome, Firefox and Safari, on the main thread and in module Workers.
  - The suite runs in Playwright's Chromium, Firefox and WebKit.
  - `pnpm test:matrix` runs it in Chrome and Firefox, each at the current and the previous major, installed by version number, and in the Safari installed on the maintainer's Mac.
  - The previous Safari major is covered by the pinned feature set, not by running it. The module uses WebAssembly 1.0 plus bulk memory and nothing else, which Safari has supported since 15. `pnpm check` fails if the module's `target_features` section declares any other feature.
- **Workers:** module Workers in browsers and `worker_threads` in Node. Each one loads its own instance.

## Assurance

What is and isn't established about this build, quoted from [ADR 0002](docs/adr/0002-mldsa-native-and-what-the-wasm-build-can-claim.md):

> - Holds: FIPS 204 correctness, checked by NIST ACVP vectors and by differential tests against the Oracle. The C source is proven free of undefined behaviour by CBMC on 64-bit targets, and its constant-time behaviour is tested by upstream with valgrind on x86_64 and aarch64 under the same clang major we compile with. Coefficient arithmetic uses fixed-width integer types whose semantics do not change on wasm32; this is an argument, not a proof.
> - Not established: the 32-bit wasm build is outside CBMC's model; wasm code generation and engine JIT compilation are unverified for constant time.

## Credits

The cryptography is [mldsa-native](https://github.com/pq-code-package/mldsa-native) v2.0.0 (commit `834a90d5e846ffa1e1611bd24e160bb2e9b86d35`), by the mldsa-native project authors. This package compiles its code unchanged. Its licence, Apache-2.0 OR ISC OR MIT, ships next to the module as `dist/LICENSE-mldsa-native`. The source this package compiles is vendored under `native/vendor/mldsa-native`.

## Rebuild the module and compare hashes

The module embedded in `dist/mldsa87-wasm.js` is committed as `src/mldsa87-wasm.ts`. Its first lines give the module's size and SHA-256. You can rebuild it from source and check that you get the same bytes.

The build runs Nix inside a container pinned by digest, so you need no Nix on your machine. You need Node 22 or later, pnpm and [Podman](https://podman.io).

1. Clone the repository and install the development dependencies:

   ```sh
   pnpm install
   ```

2. Rebuild the module with the newest clang in mldsa-native's constant-time test matrix: clang 22, from the nixpkgs revision mldsa-native pins. This regenerates `src/mldsa87-wasm.ts`:

   ```sh
   pnpm build:wasm
   ```

3. Check that nothing changed:

   ```sh
   git diff --exit-code src/mldsa87-wasm.ts
   ```

To compare an installed copy with the hash, print the SHA-256 of the module it embeds:

```sh
node -e '
const text = require("node:fs").readFileSync(process.argv[1], "utf8");
const base64 = /MLDSA87_WASM_BASE64(?:: string)? = "([^"]*)"/.exec(text)[1];
console.log(require("node:crypto").createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex"));
' node_modules/@inkrypt/ml-dsa/dist/mldsa87-wasm.js
```

`pnpm check` goes further:

- It rebuilds the module on aarch64-linux and on x86_64-linux and fails unless both builds equal the committed module byte for byte.
- It checks that the vendored source equals the pinned mldsa-native release.
- It checks that the module imports nothing, declares only the allowed WebAssembly features, and was built by the newest clang major in mldsa-native's constant-time test matrix.
- It runs lint, format, typecheck and the test suite.

It needs Vite+ (`vp`) on `PATH` to run the tests on Node 22 and Node 24.

## Development

| Command            | What it does                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `pnpm test`        | Runs the suite in Node and in Playwright's Chromium, Firefox and WebKit.                           |
| `pnpm check`       | Runs every check above.                                                                            |
| `pnpm test:matrix` | Runs the browser suite in Chrome and Firefox, current and previous major, and in the local Safari. |
| `pnpm bench`       | Compares speed with `@noble/post-quantum` in Node and each Playwright browser.                     |
| `pnpm build:wasm`  | Rebuilds the module and regenerates `src/mldsa87-wasm.ts`.                                         |

`pnpm test:matrix` downloads browsers, so it needs network access. Safari also needs Remote Automation, enabled once with `sudo safaridriver --enable`.

## Versioning

Versions stay at `0.x` until scytale, the first consumer, has migrated. After that, moving to a new mldsa-native release is a minor version and an API change is a major version.

## License

Apache-2.0 OR MIT, at your option. See `LICENSE-APACHE` and `LICENSE-MIT`. mldsa-native's licence is in `dist/LICENSE-mldsa-native`.
