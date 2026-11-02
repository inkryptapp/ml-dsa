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
4. The build lint. `build.sh` must have no shebang. The lint reads each word of it without the quoting that bash removes. Each slash must follow a letter, a digit, or `_`, as in `obj/44`. Only `$out`, `$INCLUDE`, `$MLDSA_NATIVE`, and `$parameter_set` may come before a slash. No word may hold `~`, end in a backslash, use `$'…'` quoting or a brace expansion, join a path to an option, or climb with `..`, written out or through a glob. A lone backslash that continues a line passes. Neither derivation, `wasm` nor `wasm-debug`, may name an absolute path outside `/nix/store` or a relative `..` climb.
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
9. The instruction counts. The command reads the unstripped twin from the native build. The twin's code section must equal the committed module's, and its name section must give each function a name of its own. The step decodes each function body with a decoder for the MVP opcodes plus `memory.copy` and `memory.fill`. It fails on any `memory.grow`, on an unknown opcode, such as a `v128` instruction, and on a function body that doesn't end exactly at its declared size. It then counts these instructions per function: `if`, `br_if`, `br_table`, `select`, the integer `div` and `rem` instructions, `clz`, `ctz`, `popcnt`, the floating-point instructions, `call_indirect`, and the `i64.load` instructions that read the opt-blocker's address. The twin's link exports the opt-blocker, and the step reads the address from that export. Each nonzero count must equal its entry in `packages/ml-dsa/check/expected-counts.ts`, and each entry gives a reason of one of two kinds:
   - A `public` reason says why the counted instructions depend only on public values, such as lengths, loop counters, the public key, and the signature.
   - A `declassified` reason also cites lines of the vendored source. The code of each cited line must name the value that upstream declassifies. `MLD_CT_TESTING_DECLASSIFY` must declassify that value on an earlier line of the same function, after the value's last assignment. A write to an element or a member of the value counts as an assignment. The step reads only code, so a comment neither names, assigns, nor declassifies the value. It can't see a function call that writes the value through a pointer, so review covers that.

   The step prints the total of each class.

10. The target features. The committed module's `target_features` section must list exactly `+bulk-memory-opt`. The command then runs `packages/ml-dsa/check/features.sh` with the pinned clang, `wasm-ld`, `llc`, and wasm-tools through `scripts/nix shell`. The fixtures sit in `packages/ml-dsa/check/features/`:
    - `wasm-tools validate --features=mvp,bulk-memory-opt` must accept the committed module and `bulk-memory-opt.wat`, which holds `memory.copy` and `memory.fill`. `--features=mvp` must reject that fixture.
    - Each wasm feature that `llc -mtriple=wasm32 -mattr=help` lists, except `bulk-memory-opt`, needs a row in the table in `packages/ml-dsa/check/target-features.ts` and a fixture named after clang's name for the feature. The row maps clang's name to wasm-tools' name and lists the wasm-tools features that the fixture also needs. `mvp,bulk-memory-opt` with those prerequisites must reject the fixture, and the same list with the feature added must accept it. A row without a fixture fails, and so do a fixture without a row and a row that `llc` doesn't list.
    - A feature that the pinned wasm-tools doesn't know, `fp16` today, has no wasm-tools name in its row. `mvp,bulk-memory-opt` must reject its fixture. The same list with the prerequisites, and `--features=all`, must reject it with the row's recorded message and offset. `--features=mvp,fp16` must fail because wasm-tools doesn't know the name. As a compiler witness, the step compiles `fp16.c` to assembly, which must name `f16x8.splat`. It then assembles and links that output, which must give the bytes of `fp16.wasm`. That fixture is a binary, because wasm-tools can't parse the instruction as text.
11. The host paths. The command builds the flake's `wasm-debug` package, which compiles with `-g` and links without `--strip-all`, so its debug info names each root that the compile reads. That build records its build folder in a file. The step computes the build's roots: the build folder, the vendored source and the include folder that the derivation names, and clang's resource folder. The committed module, the twin, and the `-g` module must hold none of these patterns:
    - The generic host prefixes `/nix/store`, `/nix/var`, `/build`, `/tmp`, `/home`, `/root`, `/Users`, `/private`, and `/var/folders`.
    - Each root, and the store hash of each root in the store.

    The `-g` module must have a `.debug_*` section, and its debug info must name a path under the name of each prefix map in `build.sh`, such as `mldsa-native`. First, the scan must find each pattern in a negative fixture that holds them all. Nix already fails a build of either derivation whose output names a store path that the build reads, because both set `allowedReferences = [ ]`, so a missing map for a store root fails the build before the scan runs. The scan catches a path that a change to the build leaks by accident. It reads plain bytes, so review catches a path that a script encodes on purpose.

12. The package build. The command packs the npm tarball inside the build container, once for each system that the wasm module rebuilds step built. It runs `packages/ml-dsa/check/pack.sh` with the flake's `nodejs` and `pnpm` packages through `scripts/nix shell`. The script copies each file that git tracks, outside `vectors/` and the submodule, and upstream's `LICENSE` into a folder inside the container. There it runs `pnpm install --frozen-lockfile --ignore-scripts`, `vp pack`, and `npm pack`. pnpm checks each package that it downloads against its integrity hash in `pnpm-lock.yaml`. As with the flake, a new file packs only after `git add`. The command writes each tarball to `packages/ml-dsa/packed/` and prints its SHA-256. The tarballs must be byte-identical, or hold identical archives when only their gzip layer differs.
13. The package checks. The step reads the native tarball and fails unless all of these hold:
    - The tarball's files equal the list in `packages/ml-dsa/check/tarball-files.txt`, and the tarball is at most 100,000 bytes.
    - `package.json`, `README.md`, `LICENSE`, `LICENSE-mldsa-native`, and `dist/mldsa.wasm` equal their sources: `packages/ml-dsa/package.json`, `packages/ml-dsa/README.md`, the root `LICENSE`, `vendor/mldsa-native/LICENSE`, and the committed module.
    - `package.json` sets `"type": "module"`, `"engines": { "node": ">=22" }`, the exports map of `expectedExports`, in its key order, the `mldsaNative` field, and `repository.url` as `git+https://github.com/inkryptapp/ml-dsa.git`. It has no `main`, `module`, `types`, `typings`, or `browser` field, and no field of runtime dependencies. `expectedExports` is in `packages/ml-dsa/check/package-checks.ts`.
    - No file is a vector file that `vectors/manifest.json` lists, or the test-only entry point.
    - Each import in the shipped JavaScript and declarations names another file of the tarball by a relative path, without import attributes, and no import names a `.json` file. So the package has zero runtime dependencies, and no shipped file imports noble.
    - `dist/workerd.js` imports only `./mldsa.wasm`. `dist/index.js` passes the bytes of `dist/mldsa.wasm`, as base64 text, to its one `atob` call.
    - The structural check of the core finds the core function exactly once in each entry file, `dist/index.js` and `dist/workerd.js`, and applies its rules there.
    - The path scan of step 11 finds none of its patterns in the files under `dist/` or in the module that `dist/index.js` embeds. Here the roots are the pack's folder, the repo, and the store paths of the pack's Node.js and pnpm.
    - attw, pinned in the root `package.json`, passes with `--profile esm-only` on the tarball.

14. The stack margin. `packages/ml-dsa/test/stack-margin.test.ts` runs keygen, sign, and verify for each parameter set with fixed inputs, once per byte pattern. Before each export call, the test fills the wasm stack with the pattern, and after the call it finds the deepest byte that changed. Each operation's deepest call must reach more than 0 bytes and at most 75% of the wasm stack, and it must equal the operation's peak in the test's `pinnedPeaks`. The step prints each operation's peak.
15. The vectors. `packages/ml-dsa/test/vectors.test.ts` runs the ACVP and Wycheproof cases against the committed module. The routing table in `packages/ml-dsa/test/routing-table.ts` sends each case through the public API when the API can express it, and through the test-only entry point when it can't. The HashML-DSA cases and the Wycheproof sign_noseed cases with a bad secret key don't run, because the package has no HashML-DSA and never imports a secret key. The step prints the count per path and per row, with the routing table's version, and the cases per segment from `packages/ml-dsa/test/segment-table.ts`. It fails when any of these holds:
    - A vector file has no reader, lacks the other file of its ACVP pair, isn't valid UTF-8 JSON, lists a case id twice, or disagrees with its schema, its name, its folder, its header, or the other file of its pair.
    - A case matches no row or several rows, or has the result `acceptable` and its row doesn't handle that result.
    - A case's fields disagree with what its flags, its group, or its file's format imply.
    - A call gives a result other than the one that its case expects.
    - After a row's cases, the memory of the instance differs from a fresh instance's memory.
    - A row's count or a segment's counts differ from the pinned counts.
    - A public segment has neither cases through public rows nor a named test, or a named test is missing from its file.

The pin guard reads the tags that the submodule has fetched. To update them to upstream's, run `git -C vendor/mldsa-native fetch --force --prune --prune-tags origin`. A plain `git fetch --tags` keeps a tag that upstream deleted and refuses to move a tag that upstream moved. CI checks out a fresh clone, so it always sees upstream's tags.

On an arm64 host, the command also builds the module and packs the tarball for x86_64-linux under emulation, and prints the hash of each. Arm64 Nix runs natively in the container. The command passes `--option extra-platforms x86_64-linux` on that build only, so Nix hands the x86_64 build steps to the container host's QEMU handler. On macOS, the Podman machine registers that handler. The first emulated build downloads the x86_64 toolchain from `cache.nixos.org` and takes a few minutes.

To build only the host's own system, as CI does, run `scripts/check --native-only`.

CI runs `scripts/check --native-only` natively on `ubuntu-24.04` and `ubuntu-24.04-arm`, from a clean checkout with no `/nix` cache. CI never writes, commits, or proposes the module. Each runner uploads its tarball, and a later job compares the two tarballs with `packages/ml-dsa/check/compare-tarballs.ts`, which runs the comparison of the package build step.

## Update the committed module

To change the module, such as after a pin bump or a change to `build.sh`, follow these steps:

1. Add each new build file to git with `git add`. Nix reads the working tree, but only the files that git tracks.
2. Run `scripts/check`. The wasm module rebuilds step fails, and each of its messages holds a `scripts/nix store cat` command that copies one build into `packages/ml-dsa/wasm/mldsa.wasm`.
3. Run the command from the native build's message.
4. Run `scripts/check` again. Commit the module only when every build that the command prints equals it. On an arm64 host, that includes the emulated x86_64 build.

## Update the expected values

A pin bump, a new clang, or a change to `build.sh` or the config header can change what the module interface, upstream headers, instruction counts, target features, and stack margin steps compare. A change to the package's files can change what the package checks compare. A failed comparison with a committed file names each line that the file lacks or has, or says that the lines come in another order. To accept a change, follow these steps:

1. Review each difference. For a changed C prototype, read the function's new semantics in upstream's source, not only its new signature.
2. Edit `module-exports.txt`, `prototypes.txt`, or `config-diff.txt` in `packages/ml-dsa/check/` until it holds exactly the lines that the step gives. For a moved stack peak, edit `pinnedPeaks` in `packages/ml-dsa/test/stack-margin.test.ts`.
3. If an export's wasm type changed, change its declaration in `packages/ml-dsa/src/module-exports.ts` to match.
4. For a changed instruction count, read the function's source at the new pin and find what each counted instruction tests. Then change the count and its reason together in `packages/ml-dsa/check/expected-counts.ts`. A failed site check names a cited line that no longer holds its declassification. Find the line where upstream now declassifies the value, and update the site.
5. For a feature that the pinned `llc` newly lists, add a minimal fixture to `packages/ml-dsa/check/features/` and a row to the table in `packages/ml-dsa/check/target-features.ts`. A row for an unknown feature lapses when wasm-tools learns the feature, and the step then fails until the row gets its wasm-tools name.
6. If the config diff changed, update record 0002 in `docs/adr/` and the list in `packages/ml-dsa/wasm/include/mldsa_wasm_config.h`.
7. For a change to the tarball's files, edit `packages/ml-dsa/check/tarball-files.txt` until it holds exactly the paths that the step gives. When the root `package.json`'s `packageManager` field names another pnpm version, add that version's two hashes to `nix/pnpm.nix`.
8. Run `scripts/check` again.

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
- **Run-dependent output.** Check that the `wasm` derivation's output holds only the module and its unstripped twin, with no timing or log file, so `nix build --rebuild` still passes. The `wasm-debug` derivation also records its build folder, which changes from build to build, so the check never rebuilds it with `--rebuild`.
