#!/bin/sh
# Build the .wasm with the Matched toolchain through scripts/nix, for the host
# CPU's Linux system, then regenerate the committed artifact module from it.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
WASM=$(mktemp)
trap 'rm -f "$WASM"' EXIT

cd "$ROOT/native"
out=$(../scripts/nix build path:.#default --no-link --print-out-paths)
../scripts/nix store cat "$out/mldsa87.wasm" > "$WASM"
node "$ROOT/scripts/generate-artifact.mjs" "$WASM"
