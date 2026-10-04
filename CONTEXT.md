# mldsa-wasm

An npm package that runs ML-DSA-87 (FIPS 204) from the mldsa-native C library, compiled to WebAssembly, with the same TypeScript API planned for later native bindings. Its first consumer is scytale.

## Key material

**Seed**:
The 32-byte value (FIPS 204's ξ) that a key pair is derived from. In the composite signature draft it is the ML-DSA half of a composite private key.
_Avoid_: private key, xi

**Secret key**:
The 4896-byte FIPS 204 encoding of the signing key, derived from a Seed by keygen.
_Avoid_: expanded key, private key

**Public key**:
The 2592-byte FIPS 204 encoding of the verification key.
_Avoid_: verification key

## Signing

**Signing randomness**:
The 32-byte `rnd` value supplied to a single sign call.
_Avoid_: extraEntropy, nonce

**Hedged signing**:
Signing with fresh Signing randomness, so that signing the same message twice gives different signatures.
_Avoid_: randomized signing

**Deterministic signing**:
Signing with all-zero Signing randomness, so that the signature depends only on the Secret key, Context and message.

**Context**:
The 0–255-byte string bound into a signature (FIPS 204's `ctx`); a signature verifies only under the same Context.
_Avoid_: label (scytale's name for the particular Context it uses), domain

## Assurance

**Byte contract**:
The promise that every output is byte-identical to the Oracle's for the same inputs, and that verify answers `false`, never throws, on any malformed input.

**Oracle**:
`@noble/post-quantum` 0.7.1 `ml_dsa87`, the reference implementation the package is compared against in tests.
_Avoid_: reference, baseline

**Pinned commit**:
The single mldsa-native release commit that the package is built from.

**CT matrix**:
The set of compilers that mldsa-native's upstream constant-time tests run at the Pinned commit.

**Matched toolchain**:
A clang and wasm-ld whose LLVM major is the newest clang in the CT matrix, taken from the same nixpkgs revision upstream locks.
_Avoid_: pinned compiler
