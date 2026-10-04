# Randomness enters as arguments, never as an import

The wasm module imports no randomness, and the TypeScript API never draws any: keygen takes the Seed and sign takes the Signing randomness as required 32-byte arguments, and the caller draws them (from `crypto.getRandomValues` in a browser). The RNG source is the same either way; the reasons are structural. A JS exception thrown from a randomness import unwinds through wasm frames, skipping the zeroisation of secrets on the wasm stack and leaving the module's stack pointer unrestored. An import also lets foreign code run, and re-enter the module, in the middle of an operation. And a hidden input would force every deterministic test (ACVP vectors, the Oracle comparison, scytale's own) to mock it. React Native's Hermes has no `crypto.getRandomValues`, so this also keeps the API identical across bindings.

## Consequences

- Built with `MLD_CONFIG_NO_RANDOMIZED_API`, so mldsa-native's keygen pairwise-consistency test (`MLD_CONFIG_KEYGEN_PCT`, enabled in upstream's CT and CBMC configurations) is off. PCT is a FIPS 140-3 self-test that changes no output bytes; the keygen, sign and verify code it would wrap is unchanged.
- Deterministic signing is requested by passing 32 zero bytes, not by a separate mode.
- This differs from scytale today, which lets the Oracle draw `rnd` internally; scytale's signer must draw it when it migrates.
