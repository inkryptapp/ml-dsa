# Build only with the toolchain from upstream's constant-time matrix

Every build compiles with the newest clang major in mldsa-native's CT matrix (`.github/workflows/ct-tests.yml` at the Pinned commit; clang 22 at v2.0.0), taken from the exact nixpkgs revision upstream's `flake.lock` locks. mldsa-native's C constant-time property is only tested, with valgrind, per compiler and optimisation level; an optimiser outside that matrix may turn branch-free code into branches. This rule outranks performance, convenience and toolchain freshness.

## Consequences

- mldsa-native is a flake input at the release tag, and `nixpkgs.follows = "mldsa-native/nixpkgs"`, so one `nix flake update mldsa-native` moves the source and the compiler together. Upstream's `mldsa/` tree is also vendored into the repo so that non-Nix builds (a later Rust crate, a React Native binding) and reviewers can read it; the check command fails if the vendored tree differs from the flake input.
- We use `llvmPackages_<N>.clang-unwrapped` and `lld_<N>`, not the wrapped `clang_<N>` upstream's dev shells use. It is the same compiler binary; the nix cc-wrapper only adds native-target include paths and hardening flags that do not belong in a `-nostdlib` wasm32 build. All flags are written out in our build script.
- Optimisation levels are limited to those upstream tests for that clang (`-O3` chosen; `-Ofast` excluded).
- The check command reads the clang version from the `.wasm` `producers` section and fails unless that major appears in `ct-tests.yml` at the Pinned commit. A bump to mldsa-native is incomplete until the toolchain has moved with it.

## Considered options

- Homebrew LLVM: rolling, cannot be pinned to a build.
- wasi-sdk: pins well but is not upstream's binary.
- Emscripten (as `dchest/mldsa-wasm` uses): unpinned there, links libc and an allocator, and its LLVM is not upstream's binary.
- Zig: absent from the CT matrix.
