# Ship five behavioral and two non-behavioral config differences from upstream's CT runs

Upstream's CT runs build the portable C (`OPT=0`) and the native backends (`OPT=1`) with the default config plus `MLD_CONFIG_KEYGEN_PCT` and `MLD_CONFIG_CT_TESTING_ENABLED`. The wasm module is the portable C variant, but it must import nothing, hold all three parameter sets, and link no libc. So it departs from the tested config in seven numbered ways, each for a stated reason. The config header sets items 1 to 4 and then includes upstream's default config, so every option that it doesn't name keeps upstream's default at the pin. The build script sets item 7. Upstream's `mld_zeroize` stays unchanged.

Behavioral differences:

1. **`MLD_CONFIG_MULTILEVEL_BUILD`**, with `MLD_CONFIG_MULTILEVEL_WITH_SHARED` for ML-DSA-44 and `MLD_CONFIG_MULTILEVEL_NO_SHARED` for ML-DSA-65 and ML-DSA-87. One module holds all three parameter sets, and the shared code exists once.
2. **`MLD_CONFIG_NO_RANDOMIZED_API`.** The module imports nothing and draws no randomness, so the caller supplies the seed and the signing randomness to upstream's internal functions.
3. **`MLD_CONFIG_CUSTOM_MEMCPY` and `MLD_CONFIG_CUSTOM_MEMSET`**, mapped to `__builtin_memcpy` and `__builtin_memset`. The build links no libc, and with `bulk-memory-opt` the builtins become `memory.copy` and `memory.fill`.
4. **`MLD_CONFIG_NO_ASM_VALUE_BARRIER`.** Upstream's asm barrier constrains only LLVM and leaves no instruction in the module, so an engine's optimizing tier can see through it. The volatile barrier survives as an `i64.load` and an `i64.xor` of a value that no engine can know, because the host can change exported memory between calls. The CT matrix tests neither barrier as wasm, so keeping the asm barrier would match the tested config in name only. Upstream documents the volatile barrier as a config option, and its CBMC proofs of the barriers and the constant-time helpers use it. It costs 252 bytes and no measurable time.
5. **No `MLD_CONFIG_KEYGEN_PCT`.** Upstream's `common.h` rejects it together with `MLD_CONFIG_NO_RANDOMIZED_API`, because its PCT calls the randomized `signature()`. The PCT is a FIPS 140-3 self-test. It changes no output and leaves the source of keygen, sign, and verify unchanged, but the CT runs compiled a keygen function with the check inside. A PCT in the TypeScript wrapper would cost a sign and a verify, about 0.5 ms for ML-DSA-87, and every sign that starts from a seed would pay it.

Non-behavioral differences:

6. **No `MLD_CONFIG_CT_TESTING_ENABLED`.** It adds valgrind annotations for testing only and never ships.
7. **The namespace prefix `mldsa`** in place of upstream's default. It changes symbol names only.

## Consequences

- The check preprocesses a one-line file that includes upstream's `common.h` with `clang -dM -E`. It runs once per object variant with the shipped config, and once with the CT config, which needs an empty `valgrind/memcheck.h` stub. It fails unless the difference in `MLD_CONFIG_*` macros equals a committed expected diff, which also lists `MLD_CONFIG_FILE`. A pin bump that changes a default that touches the shipped build, or a new `-D` flag, then fails the check.
- The per-function instruction counts include the `i64.load` instructions that read the opt-blocker's address, 29 at `-O3` with clang 22.1.5 at the pin. A toolchain change that folds the volatile barrier away then fails the check.
- The opt-blocker lives in static data below `__heap_base`. The wrapper writes nothing there except the stack wipe, and `--stack-first` keeps the stack below the static data. Byte-for-byte tests against reference outputs would catch a corrupted blocker.
- Known-answer and cross-implementation tests run in every supported engine, long enough to reach each engine's top tier. They cover the runtime miscompilation that a PCT would catch.
- The config header comment and the README list these seven numbered items and point to this record.

## Considered options

- **Keep the asm barrier.** It is the only barrier that upstream's CT runs build, but they build it for native targets only. Reopen if wasm-level constant-time evidence shows that the asm barrier holds through every engine tier.
- **A PCT in the TypeScript wrapper.** It roughly doubles the cost of every sign that starts from a seed. Reopen when upstream offers a PCT without the randomized API, or when a consumer needs FIPS 140-3 validation, and treat either case as a separate decision.
- **A `randombytes` of the repo's own, to keep the randomized API and the PCT.** The module would have to import randomness or carry a C wrapper. The rule that the wasm module imports nothing excludes the import, and the rule that the repo adds no C wrapper to the vendored source excludes the wrapper.
- **A copy of upstream's default config.** It would hide the defaults that a later pin adds or changes.
- **libc's `memcpy` and `memset`.** The build links no libc.
