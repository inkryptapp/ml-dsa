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
2. The flake rules. `nix/tests.nix` calls the rules in `nix/lib.nix`, which `flake.nix` applies to upstream's `flake.lock` and to `packages/ml-dsa/wasm/sizes.json`. Each rule must reject every broken input in the tests and accept a valid one. A broken real file fails the next step, and Nix prints the rule's message.
3. The build lint. `build.sh` must have no shebang. The lint reads each word of it without the quoting that bash removes. Each slash must follow a letter, a digit, or `_`, as in `obj/44`. Only `$out`, `$INCLUDE`, `$MLDSA_NATIVE`, and `$parameter_set` may come before a slash. No word may hold `~`, end in a backslash, use `$'…'` quoting or a brace expansion, join a path to an option, or climb with `..`, written out or through a glob. A lone backslash that continues a line passes. The derivation may name no absolute path outside `/nix/store` and no relative `..` climb.
4. The wasm module rebuilds. The command builds the module for the host's own system, then builds it again with `nix build --rebuild`, which fails unless both runs give the same bytes. Each build must equal the committed module, and the command prints the SHA-256 of each one.

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
