# ml-dsa

This repo compiles the mldsa-native C library to a WebAssembly module and wraps it for JavaScript runtimes. Consumer apps use it for the ML-DSA half of a composite signature.

## Language

### Keys and signing inputs

**Parameter set**:
One of the three ML-DSA configurations in FIPS 204: ML-DSA-44, ML-DSA-65, or ML-DSA-87.
_Avoid_: level, security level, variant

**Seed**:
The 32-byte value, called ξ in FIPS 204, from which key generation derives a key pair.
_Avoid_: private key, key material

**Secret key**:
The expanded ML-DSA private key that key generation derives from a seed and that signing consumes.
_Avoid_: private key, signing key

**Signing randomness**:
The 32-byte value, called rnd in FIPS 204, that the caller supplies to each signing call.
_Avoid_: nonce, salt, entropy

**Context string**:
The 0 to 255 bytes, called ctx in FIPS 204, that bind a signature to one application domain. The composite passes its label as the ML-DSA half's context string.
_Avoid_: label (alone), domain tag, ctx (in prose)

### Signing and verification

**Hedged signing**:
Signing with fresh signing randomness, which FIPS 204 makes the default.
_Avoid_: randomized signing, probabilistic signing

**Deterministic variant**:
The FIPS 204 signing variant whose signing randomness is 32 zero bytes, so one key and one message always give the same signature.
_Avoid_: deterministic mode, nonce-free signing

**Public-key hash**:
The 64-byte SHAKE256 hash of the encoded public key, called tr in FIPS 204. The encoded secret key also holds it.
_Avoid_: key ID, fingerprint

**Domain-separation prefix**:
The bytes that pure ML-DSA puts before the message: a zero byte, the context string's length, and the context string.
_Avoid_: header, M' (which is the prefix plus the message)

**Message representative**:
The 64-byte value, called μ in FIPS 204, that hashes the public-key hash, the domain-separation prefix, and the message. Signing and verification consume it.
_Avoid_: digest, message hash, pre-hash

**External mu**:
Signing or verifying from a message representative that was computed outside upstream's own signing and verification functions.
_Avoid_: pre-hashing, HashML-DSA (a different FIPS 204 variant)

### Composite signatures

**Composite signature**:
A signature under id-MLDSA87-ECDSA-P384-SHA512 from draft-ietf-lamps-pq-composite-sigs-19, which pairs an ML-DSA-87 signature with an ECDSA P-384 signature.
_Avoid_: hybrid signature, dual signature

**ML-DSA half**:
The ML-DSA-87 part of a composite signature, and the only part this package produces.
_Avoid_: PQ half, post-quantum component

### Build provenance

**Upstream**:
The mldsa-native C library from the pq-code-package project.
_Avoid_: the C library, mldsa

**Pin**:
The commit of a stable upstream release that this repo builds from.
_Avoid_: version, upstream revision

**Pin bump**:
A change that moves the pin to a newer stable upstream release.
_Avoid_: upstream upgrade, dependency update

**Vendored source**:
The copy of upstream at the pin that the build compiles. Every file in it is byte-identical to the pin.
_Avoid_: fork, patched source

**Shim header**:
A declaration-only header of this repo's own that stands in for a header upstream includes but the wasm32 build lacks.
_Avoid_: patch, stub, C wrapper

**CT matrix**:
The compilers that upstream's `ct-tests.yml` runs its constant-time tests with, as of the pin.
_Avoid_: compiler matrix, supported compilers

**Toolchain match**:
The rule that the newest clang major in the CT matrix compiles the wasm module, as the same clang binary that upstream's CT runs use.
_Avoid_: compiler pin, supported compiler

**Config difference**:
An upstream config option that the shipped build sets differently from upstream's CT runs.
_Avoid_: deviation, patch, override

**Wasm module**:
The wasm32 binary that this repo compiles from the vendored source.
_Avoid_: transpiled module, wasm blob

### Memory

**Instance**:
One instantiation of the wasm module, with a linear memory of its own. Every call runs on one instance.
_Avoid_: module (for an instance), sandbox

**Wasm stack**:
The C call stack that lives inside an instance's linear memory. It excludes the engine's own machine stack and registers.
_Avoid_: shadow stack, the stack

**Static data**:
The module's constants and initialized data, which sit in an instance's linear memory between the wasm stack and the regions.
_Avoid_: data section (the module's bytes), globals

**Region**:
A fixed run of an instance's linear memory that holds one input, output, or intermediate value of a call.
_Avoid_: buffer, slot

**Healthy instance**:
An instance whose memory equals a fresh instance's memory between calls, so the next call can run on it.
_Avoid_: clean instance, valid instance

**Poisoned instance**:
An instance that a call held when an exception was thrown, or that an inner call zeroed. The call that held it zeroes its whole memory and drops it.
_Avoid_: broken instance, dirty instance

**Wipe**:
The zeroing that ends every call: the wasm stack and every byte after the static data on a healthy instance, or the whole memory of a poisoned instance.
_Avoid_: clear, scrub, zeroize (which upstream zeroization does)

**Inner call**:
A call that a debugger or an export hook starts while another call, the outer call, holds the instance. After its input checks, it zeroes the outer call's instance and runs on a new one.
_Avoid_: re-entrant call, takeover

**Stopped call**:
A call that the runtime stopped midway, so none of its cleanup ran, as on a `vm` timeout or a debugger's terminate command.
_Avoid_: aborted call, interrupted call, killed call

**Recovery**:
The replacement of an instance that a call can't trust with a new one: after a poisoned instance, or after a stopped call, whose instance the next call zeroes first.
_Avoid_: reset, restart

**Upstream zeroization**:
Upstream's own zeroing of the secret buffers that it frees. The package keeps it unchanged and relies on its own wipe instead.
_Avoid_: wipe (which is the package's own)

### Package surface

**Test-only entry point**:
The unpublished module that tests import to call the wasm module's raw exports and to sign from a secret key, built from the same functions as the public API.
_Avoid_: test hook, debug API, internal API

**Port**:
This repo's build of upstream for one platform, shipped in packages of its own. The npm package `ml-dsa` is the wasm port.
_Avoid_: binding, wrapper

### Runtimes

**Web Worker**:
A dedicated, shared, or service worker in a browser.
_Avoid_: Workers (alone)

**Cloudflare Worker**:
A script that runs on Cloudflare's workerd runtime.
_Avoid_: Workers (alone), edge worker

**Branded browser**:
A Chrome, Firefox, or Safari build that Google, Mozilla, or Apple ships to users. Playwright's own Chromium, Firefox, and WebKit builds aren't branded browsers.
_Avoid_: stock browser, real browser
