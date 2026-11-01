# How to build and check the wasm module

The build compiles the wasm module at `packages/ml-dsa/wasm/mldsa.wasm` from the mldsa-native submodule at `vendor/mldsa-native`. `scripts/nix` runs Nix inside the digest-pinned `nixos/nix` image, with the settings in `nix.conf`. `flake.nix` takes clang 22 and `lld` from the nixpkgs revision that upstream's own `flake.lock` locks. It then runs `packages/ml-dsa/wasm/build.sh`, which holds every compiler and linker flag. Records 0001 to 0003 in `docs/adr/` hold the reasons.

You need Docker or Podman. `scripts/nix` uses Docker when it's on `PATH`, and Podman otherwise.

## Check the build

Run the check command from the repo root:

```sh
pnpm install
scripts/check
```

The command stops at the first step that fails and says what failed and why. It runs these steps in order:

1. The pin guard. The submodule must be initialized, sit at the gitlink, and have no changes or untracked files, ignored ones included. The gitlink must be the commit of a stable upstream tag of the form `vX.Y.Z`. The `mldsaNative` field in `packages/ml-dsa/package.json` and the independent-build statement in `packages/ml-dsa/README.md` must both name that tag and commit.
2. The vector manifest. Each file in `vectors/` must match its SHA-256 in `vectors/manifest.json`, and each entry's URL must be the `raw.githubusercontent.com` URL of its repository, commit, and path. A missing file, an extra file, or a file listed twice fails the step. [How to update the vectors](vectors.md) covers a change to the files.
3. The flake rules. `nix/tests.nix` calls the rules in `nix/lib.nix`, which `flake.nix` applies to upstream's `flake.lock` and to `packages/ml-dsa/wasm/sizes.json`. Each rule must reject every broken input in the tests and accept a valid one. A broken real file fails the next step, and Nix prints the rule's message.
4. The build lint. `build.sh` must have no shebang. The lint reads each word of it without the quoting that bash removes. Each slash must follow a letter, a digit, or `_`, as in `obj/44`. Only `$out`, `$INCLUDE`, `$MLDSA_NATIVE`, and `$parameter_set` may come before a slash. No word may hold `~`, end in a backslash, use `$'…'` quoting or a brace expansion, join a path to an option, or climb with `..`, written out or through a glob. A lone backslash that continues a line passes. The derivation may name no absolute path outside `/nix/store` and no relative `..` climb.
5. The wasm module rebuilds. The command builds the module for the host's own system, then builds it again with `nix build --rebuild`, which fails unless both runs give the same bytes. Each build must equal the committed module, and the command prints the SHA-256 of each one.
6. The toolchain match. The committed module must have one `producers` section, whose `processed-by` field lists only the pinned clang. The command reads the pinned clang's version from the flake's `clang` package. The clang major must be the newest clang major in the `nix-shell` list of the matrix in `vendor/mldsa-native/.github/workflows/ct-tests.yml`. A compiler that only a comment or a step condition names doesn't count, and neither does a job whose condition is `false`. The one `-O` flag in `build.sh` must be a level that the matrix's CT steps run for that clang, after their step conditions. A CT step counts only when its `cflags` hold one `-O` flag and otherwise only `-D` definitions, so a step with `-O3 -ffast-math` doesn't count. The step can evaluate only step conditions that compare `matrix.nix-shell` with string literals. It fails on any other step or job condition and on a matrix with `include` or `exclude` entries.
7. The module interface. The step reads the committed module's bytes, without a rebuild, and fails unless all of these hold:
   - Each export, with its kind and wasm type, equals the list in `packages/ml-dsa/check/module-exports.txt`, in order.
   - The module imports nothing, and the memory's initial size equals its maximum.
   - `__heap_end` and the memory both span `memoryBytes` from `packages/ml-dsa/wasm/sizes.json`, and `__stack_high` minus `__stack_low` equals `stackBytes`.
   - The declaration of the raw exports in `packages/ml-dsa/src/module-exports.ts` matches the export list. The step generates a type-level check from the list and runs the workspace's TypeScript on it. Each `i32` parameter must be a `number` or a branded `number`, and each global must be an immutable `i32` `WebAssembly.Global`.
8. The upstream headers. The command runs `build.sh probe` with the pinned clang through `scripts/nix shell`, on the working tree's `vendor/mldsa-native` and `packages/ml-dsa/wasm/include`. Each probe compiles once per parameter set with that parameter set's object flags from `build.sh`:
   - The C prototypes. clang prints the declaration of each function that the module exports, from upstream's `src/sign.h` and `src/fips202/fips202.h`. The declarations must equal `packages/ml-dsa/check/prototypes.txt`.
   - The layout probe. The command generates one `_Static_assert` per constant in `packages/ml-dsa/src/upstream.ts`, plus the seed and randomness lengths. Each one states the C expression that the constant must equal, such as `sizeof(mld_shake256ctx)`. The probe must compile under `-fsyntax-only`, with `-Wno-c11-extensions` added. A line that expects a wrong value must fail with a static assertion, which proves that the compile evaluates the assertions.
   - The config diff. `clang -dM -E` over a file that includes upstream's `src/common.h` lists the `MLD_CONFIG_*` macros under the shipped config. It runs once more under upstream's CT config, which adds two sets of `-D` definitions to upstream's default config. The command reads both from upstream's files at the pin: the set that `.github/actions/ct-test/action.yml` adds to every CT step, and the set of the step in `ct-tests.yml` that tests the build's `-O` level with the newest clang. The CT config run gets an empty `valgrind/memcheck.h` stub. The step fails when the newest clang's steps test the build's level with more than one set of definitions. The difference must equal `packages/ml-dsa/check/config-diff.txt`. Record 0002 explains each difference.
9. The stack margin. `packages/ml-dsa/test/stack-margin.test.ts` runs keygen, sign, and verify for each parameter set with fixed inputs, once per byte pattern. Before each export call, the test fills the wasm stack with the pattern, and after the call it finds the deepest byte that changed. Each operation's deepest call must reach more than 0 bytes and at most 75% of the wasm stack, and it must equal the operation's peak in the test's `pinnedPeaks`. The step prints each operation's peak.
10. The vectors. `packages/ml-dsa/test/vectors.test.ts` runs the ACVP and Wycheproof cases against the committed module. The routing table in `packages/ml-dsa/test/routing-table.ts` sends each case through the public API when the API can express it, and through the test-only entry point when it can't. The HashML-DSA cases and the Wycheproof sign_noseed cases with a bad secret key don't run, because the package has no HashML-DSA and never imports a secret key. The step prints the count per path and per row, with the routing table's version, and the cases per segment from `packages/ml-dsa/test/segment-table.ts`. It fails when any of these holds:
    - A vector file has no reader, lacks the other file of its ACVP pair, isn't valid UTF-8 JSON, lists a case id twice, or disagrees with its schema, its name, its folder, its header, or the other file of its pair.
    - A case matches no row or several rows, or has the result `acceptable` and its row doesn't handle that result.
    - A case's fields disagree with what its flags, its group, or its file's format imply.
    - A call gives a result other than the one that its case expects.
    - After a row's cases, the memory of the instance differs from a fresh instance's memory.
    - A row's count or a segment's counts differ from the pinned counts.
    - A public segment has neither cases through public rows nor a named test, or a named test is missing from its file.

The pin guard reads the tags that the submodule has fetched. To update them to upstream's, run `git -C vendor/mldsa-native fetch --force --prune --prune-tags origin`. A plain `git fetch --tags` keeps a tag that upstream deleted and refuses to move a tag that upstream moved. CI checks out a fresh clone, so it always sees upstream's tags.

On an arm64 host, the command also builds the module for x86_64-linux under emulation and prints that build's hash. Arm64 Nix runs natively in the container. The command passes `--option extra-platforms x86_64-linux` on that build only, so Nix hands the x86_64 build steps to the container host's QEMU handler. On macOS, the Podman machine registers that handler. The first emulated build downloads the x86_64 toolchain from `cache.nixos.org` and takes a few minutes.

To build only the host's own system, as CI does, run `scripts/check --native-only`.

CI runs `scripts/check --native-only` natively on `ubuntu-24.04` and `ubuntu-24.04-arm`, from a clean checkout with no `/nix` cache. CI never writes, commits, or proposes the module.

## Update the committed module

To change the module, such as after a pin bump or a change to `build.sh`, follow these steps:

1. Add each new build file to git with `git add`. Nix reads the working tree, but only the files that git tracks.
2. Run `scripts/check`. The wasm module rebuilds step fails, and each of its messages holds a `scripts/nix store cat` command that copies one build into `packages/ml-dsa/wasm/mldsa.wasm`.
3. Run the command from the native build's message.
4. Run `scripts/check` again. Commit the module only when every build that the command prints equals it. On an arm64 host, that includes the emulated x86_64 build.

## Update the expected values

A pin bump, a new clang, or a change to `build.sh` or the config header can change what the module interface, upstream headers, and stack margin steps compare. A failed comparison with a committed file names each line that the file lacks or has, or says that the lines come in another order. To accept a change, follow these steps:

1. Review each difference. For a changed C prototype, read the function's new semantics in upstream's source, not only its new signature.
2. Edit `module-exports.txt`, `prototypes.txt`, or `config-diff.txt` in `packages/ml-dsa/check/` until it holds exactly the lines that the step gives. For a moved stack peak, edit `pinnedPeaks` in `packages/ml-dsa/test/stack-margin.test.ts`.
3. If an export's wasm type changed, change its declaration in `packages/ml-dsa/src/module-exports.ts` to match.
4. If the config diff changed, update record 0002 in `docs/adr/` and the list in `packages/ml-dsa/wasm/include/mldsa_wasm_config.h`.
5. Run `scripts/check` again.

## Build without the pinned image or the cached clang

No mirror holds the image or the toolchain. The committed module makes each fallback self-checking, because the fallback build must still give the committed bytes.

- If `cache.nixos.org` stops serving the pinned clang, Nix builds it from source. The build needs no change, but it takes hours.
- If Docker Hub stops serving the image, any Nix from 2.27 on can run the flake, because Nix 2.27 added `inputs.self.submodules`. Put the digest of another image with such a Nix in `scripts/nix`, or run Nix on an aarch64-linux or x86_64-linux host with the settings from `nix.conf`.

## Review a change to the build

The container isolates the build in place of the Nix sandbox, so `nix.conf` sets `sandbox = false`. Nothing then stops a build step from reading the container's files or reaching the network. The build lint catches a path outside `/nix/store` that an author writes in `build.sh` or the derivation by mistake. It reads only the text, so a script written to evade it can still build a path at run time, for example by emptying `$out` or another variable that may come before a slash, or with a command such as `$(printf '\057etc')`. Review catches that. Review every change to `build.sh`, `flake.nix`, or `nix/lib.nix` for these items:

- **Network access during the build.** The builder runs with the container's network. Check that the change adds no step that downloads or uploads anything. The builder's `PATH` holds only coreutils, and the build lint rejects a `/dev/tcp` or `/dev/udp` redirection that the script writes out. Nix's own fetches stay pinned:
  - Nix fetches the nixpkgs source by its `narHash`.
  - Nix downloads the toolchain from `cache.nixos.org` and checks its signature, because `nix.conf` sets `require-sigs = true`.
  - When the superproject has no uncommitted changes, Nix fetches the submodule from the URL in `.gitmodules`, at the gitlink commit.
- **Run-dependent output.** Check that the derivation's output holds only the module and its unstripped twin, with no timing or log file, so `nix build --rebuild` still passes.
