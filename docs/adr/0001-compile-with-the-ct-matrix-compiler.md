# Compile the wasm module with the newest clang in upstream's CT matrix, taken from upstream's locked nixpkgs

mldsa-native's constant-time property is tested only per compiler and optimization level. Upstream's `ct-tests.yml` runs patched valgrind over native Linux builds, and an optimizer outside that matrix may turn branch-free C into branches. So the wasm module is built with the newest clang major in the matrix at the pin, which is clang 22 at v2.0.0, because the newest major stays in the matrix longest. The build takes the exact unwrapped clang and `lld` from the `nixpkgs` node that upstream's `flake.lock` locks. It reads that lock from the git submodule that is the repo's only pin, so one gitlink moves the source and the compiler together. The build runs only on Linux, inside a digest-pinned `nixos/nix` image, both locally and in CI. It uses `-O3`, which the matrix tests and which runs fastest, with upstream's flags-only multilevel layout and no LTO, because upstream's tests compile one object per source file. No post-link optimizer runs, because none is in the matrix. This rule outranks performance, convenience, and toolchain freshness.

## Consequences

- The check reads the clang major from the module's producers section and fails unless it equals the newest clang major in the `nix-shell` list of the matrix in `ct-tests.yml` at the pin. Step conditions and comments in that file don't count. A pin bump is incomplete until the toolchain has moved with the matrix.
- The check fails unless the `-O` level is one that the matrix tests for that clang, and unless `processed-by` lists only the pinned clang.
- One entry point runs a guard before every build. The guard fails unless the submodule is initialized, sits at the gitlink, and has no changes or untracked files. It also fails unless the gitlink is the commit of a stable upstream tag of the form `vX.Y.Z`, so a tag such as `v2.1.0-rc1` fails, and unless the package's `mldsaNative` field and its README's independent-build statement both name that tag and commit. The guard reads the tag's commit from the submodule's fetched tags as `vX.Y.Z^{commit}`, because the object of an annotated tag isn't a commit.
- The flake resolves nixpkgs through `nodes.root.inputs.nixpkgs` in the submodule's `flake.lock` and fetches it by `narHash`. It fails if that entry is missing or names a node that isn't on GitHub.
- The repo commits the module. CI rebuilds it natively on `ubuntu-24.04` and `ubuntu-24.04-arm` and compares bytes, but it never writes, commits, or proposes the module. That comparison enforces "no post-link pass", and the per-function instruction counts are a second guard.
- A committed `nix.conf` and one wrapper script make local and CI builds the same. The container isolates the build in place of the Nix sandbox, so a lint rejects any absolute path outside `/nix/store` in the build script and the derivation.

## Considered options

- **The official LLVM 22.1.5 tarball.** It gives the same code, but it isn't the binary that the CT matrix ran. It weighs 1.8 to 1.9 GB per architecture, and its `lld` needs a system `libxml2`. Reopen if `cache.nixos.org` stops serving the pin's clang and a source rebuild proves impractical.
- **An upstream flake input with `follows`.** It works, but it adds a second pin next to the submodule. Reopen if Nix drops `inputs.self.submodules`.
- **`-Os` or `-Oz`.** They give about half the size but run 7 to 18% slower, and size isn't a goal. Reopen if module size becomes a problem for consumers, and choose only among levels that the matrix tests.
- **A single-unit build of `mldsa_native.c`.** Upstream supports it, but it lets clang inline across files, which upstream's tests never compile. Reopen if upstream's CT runs move to single-unit builds.
- **`wasm-opt`.** It runs after LLVM, where upstream's barriers no longer bind, and it added 97 unreviewed `if` instructions. Reopen only if upstream's CT tests cover a module that Binaryen processed.
- **A wasi sysroot for `<string.h>`.** It gives the same bytes, but it adds a 124 MB tarball to pin and puts a libc in the include path. Reopen if upstream starts to need libc headers that an empty shim can't stand in for.
- **Emscripten, wasi-sdk, or `zig cc`.** Emscripten ships top-of-tree LLVM, wasi-sdk ships its own clang build, and `zig cc` turns `-O3` into `-O2`. None of them gives the matrix's binary.
- **Nix installed on the CI runners.** Local and CI builds would drift apart. Reopen if the container can't run on a runner.
- **A mirror of the toolchain and the image.** It isn't needed while the committed module makes both fallbacks self-checking. Add one if a fallback is ever needed in practice.
- **The Nix sandbox.** It needs container privileges that nobody has tested on the CI runners. Reopen when the runners support a sandboxed Nix inside the container.
