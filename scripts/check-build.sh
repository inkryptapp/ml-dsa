#!/bin/sh
# Prove the committed artifact from source (ADRs 0001, 0004 and 0005), through scripts/nix:
# - the vendored mldsa-native tree equals the flake input;
# - the module rebuilds on aarch64-linux and on x86_64-linux, one of them through extra-platforms emulation, and
#   each rebuild regenerates src/mldsa87-wasm.ts byte for byte;
# - the module imports nothing, uses only the allowed wasm features, and was built by a clang in the CT matrix
#   of ct-tests.yml at the Pinned commit.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$ROOT/native"

echo "==> vendored mldsa-native equals the flake input"
../scripts/nix flake check path:.

for system in aarch64-linux x86_64-linux; do
  echo "==> rebuild for $system"
  # Build once if the output is missing, then --rebuild, which compiles again and fails unless the result
  # equals the existing output, so every check runs the compiler.
  set -- "path:.#packages.$system.default" --option extra-platforms "aarch64-linux x86_64-linux" --no-link
  out=$(../scripts/nix build "$@" --print-out-paths)
  ../scripts/nix build "$@" --rebuild
  ../scripts/nix store cat "$out/mldsa87.wasm" > "$WORK/$system.wasm"
done

echo "==> artifact checks"
source=$(../scripts/nix flake archive --json path:. |
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).inputs["mldsa-native"].path)')
../scripts/nix store cat "$source/.github/workflows/ct-tests.yml" > "$WORK/ct-tests.yml"
node "$ROOT/scripts/check-artifact.mjs" --ct-tests "$WORK/ct-tests.yml" "$WORK/aarch64-linux.wasm" "$WORK/x86_64-linux.wasm"
