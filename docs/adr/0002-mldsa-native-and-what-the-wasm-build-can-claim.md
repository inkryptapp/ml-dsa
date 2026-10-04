# mldsa-native over RustCrypto, and what the wasm build can claim

We compile mldsa-native rather than RustCrypto's `ml-dsa` crate, and we do so knowing that none of mldsa-native's formal guarantees extend to a wasm32 build. CBMC's memory- and type-safety proofs assume a 64-bit target, the C code's constant-time behaviour is tested (valgrind, x86_64 and aarch64) rather than proven, and HOL-Light covers only native assembly that wasm does not use. The choice rests on maturity (v2.0.0, shipped in AWS-LC and liboqs, against `ml-dsa` 0.1.1 whose README says "never been independently audited! USE AT YOUR OWN RISK!"), on the constant-time testing that exists only for mldsa-native, and on one C source serving the browser build, a Tauri native signer (where the HOL-Light-verified assembly does apply) and a React Native JSI binding.

## What the README states

- Holds: FIPS 204 correctness, checked by NIST ACVP vectors and by differential tests against the Oracle. The C source is proven free of undefined behaviour by CBMC on 64-bit targets, and its constant-time behaviour is tested by upstream with valgrind on x86_64 and aarch64 under the same clang major we compile with. Coefficient arithmetic uses fixed-width integer types whose semantics do not change on wasm32; this is an argument, not a proof.
- Not established: the 32-bit wasm build is outside CBMC's model; wasm code generation and engine JIT compilation are unverified for constant time.

## Considered options

- RustCrypto `ml-dsa`: Rust's memory safety holds on wasm32 unconditionally, which is the strongest point against this decision. Rejected for immaturity and the lack of any constant-time testing. Reopen if it gains an independent audit.
- memory64 (64-bit wasm pointers), which would match CBMC's 64-bit model more closely: rejected because stable Safari (through 27.1) and Node 22 do not support it, and its explicit bounds checks cost speed. Reopen when stable Safari ships it and Node 22 is out of the support floor.
- Adopting or forking `dchest/mldsa-wasm` (npm `mldsa-wasm`): its public API has no explicit Signing randomness and its verify throws, so it cannot meet the Byte contract; its Emscripten toolchain is unpinned. Rejected in favour of our own build, though its raw exports matched the Oracle byte for byte, which confirmed the Byte contract is reachable from mldsa-native.
