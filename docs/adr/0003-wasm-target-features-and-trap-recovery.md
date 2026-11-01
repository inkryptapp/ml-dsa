# Target the wasm MVP plus bulk-memory-opt, export no mutable global, and replace the instance after any trap

2026-11-01: record 0006 revises what this record says about poisoning and replacing the instance.

Beyond the MVP, the module needs only `memory.copy` and `memory.fill`. `-mcpu=lime1` and clang's `generic` also enable `sign-ext`, `multivalue`, `nontrapping-fptoint`, `extended-const`, and `call-indirect-overlong`. A later clang could start to use any of them without a source change and silently raise the runtime floor, and `extended-const` already sits exactly at Safari 17.4. So the build passes `-mcpu=mvp -mbulk-memory-opt` and no other feature flag, which gives a code section byte-identical to the lime1 build. A trap leaves `__stack_pointer` where the trap happened, and after a stack overflow every later call traps. Resetting it needs an exported mutable global and wrapper code that knows the module's internals. So the module exports no mutable global, and any exception out of an export poisons the instance: the wrapper zeroes it, drops it, and instantiates the cached `WebAssembly.Module` again. SIMD stays out, because every tier of all three engines turns a `v128` `select` into a branch, and `-msimd128` gains only about 10% on keygen, 8% on verify, and nothing on sign.

## Consequences

- The link keeps `target_features`, and the check fails unless its entries equal exactly `+bulk-memory-opt`. A missing section also fails.
- `wasm-tools validate --features=mvp,bulk-memory-opt` must accept the module.
- `wasm-ld` refuses to export `__stack_pointer` without `mutable-globals`, so re-adding that export fails the link.
- Every feature that the pinned `llc -mtriple=wasm32 -mattr=help` lists outside the allowlist has a minimal negative fixture, 17 today. Each fixture must be rejected with its prerequisites alone and accepted with its feature added. A table maps clang's feature names to wasm-tools' names. A feature without a fixture fails the check.
- A feature that the pinned clang can enable but the pinned wasm-tools doesn't know, `fp16` today, gets three runs instead. The allowlist alone must reject it. The allowlist plus its prerequisites, and `--features=all`, must both reject it at the recorded offset and subopcode. Clang's `-S` output must name the instruction, and assembling that output with the same clang must reproduce the committed fixture. The exception lapses when wasm-tools learns the feature, and it may cover only features that clang lists and wasm-tools doesn't know.
- A positive fixture with `memory.copy` and `memory.fill` must pass with the allowlist alone.
- A recovery test forces an out-of-bounds trap through a test-only entry point. It then checks that the old memory reads as zeros, and that the next keygen, sign, and verify return known-answer bytes. The test also runs on Chromium's main thread.

## Considered options

- **`-mcpu=lime1`.** It is stable, but it enables five features that the module doesn't use. Enable a single extra feature only with a measured reason.
- **Clang's `generic`.** LLVM changed its feature set in both release 19 and release 20.
- **`-mbulk-memory`.** It also allows passive data segments, `memory.init`, `data.drop`, and the table instructions, which the module doesn't use.
- **Export `__stack_pointer` and reset it after a trap.** It needs `mutable-globals` and wrapper code that knows the module's internals.
- **Asynchronous re-instantiation with a "not ready" error.** Chrome 115 and later allow synchronous instantiation of modules up to 8 MiB on the main thread. Reopen if the main-thread recovery test fails.
- **`-msimd128`.** Reopen only with constant-time evidence for the wasm SIMD build: an upstream wasm SIMD backend that upstream's CT tests cover, or an engine-level analysis of which `v128` operations stay branch-free in each tier. Treat it as a separate, measured change with its own record.
