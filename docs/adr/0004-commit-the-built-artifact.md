# Commit the built artifact and prove it reproduces

The generated ESM module that embeds the `.wasm` is committed to git, and publishing ships the committed file. The check command rebuilds it from the Pinned commit with the Matched toolchain on x86_64-linux and aarch64-linux and fails if either rebuild differs by a single byte. This puts every change to the shipped wasm in front of a reviewer as a diff, gives scytale's `crypto-artifacts.json` hash a source of truth in git, and turns the reproducible-build requirement into a check that runs on every change. Do not move the build to publish time: an artifact that exists only on a build server can't be reviewed and can't be rebuilt and compared by anyone else.

## Consequences

- Every build runs on Linux Nix. On macOS it runs inside a `nixos/nix` container (pinned by digest, `/nix` kept in a named volume) through `scripts/nix`, with no Nix installed on the host. Upstream's constant-time tests run only on Linux, so the Linux `clang_<N>` binary is the one upstream actually tests; a darwin build of the same clang is a different binary that upstream never runs.
- The two rebuilds use different host architectures and therefore different compiler binaries, which is what makes the comparison a real reproducibility test.
- While the repository is local only, the maintainer runs the comparison with the check command. The x86_64-linux build runs through Nix's `extra-platforms` option on the aarch64 VM, because x86_64 Nix itself can't run under emulation. Once the repository is public, native x86_64 and arm64 CI runners will run the same check.

## Considered options

- Comparing a macOS Nix build with a Linux one: rejected, because it would make the untested darwin compiler part of the release path.
