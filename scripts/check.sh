#!/bin/sh
# `pnpm check`: everything but the browser version matrix and the benchmark. Stops at the first failure.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$ROOT"
command -v vp >/dev/null || {
  echo "pnpm check: needs vp (Vite+) on PATH to run the tests on Node 22 and Node 24" >&2
  exit 1
}

echo "==> lint, format, typecheck"
pnpm lint
pnpm fmt:check
pnpm typecheck

# vp (Vite+) runs each Node major the package supports. Node 24 also runs the Playwright browsers.
echo "==> tests on Node 22"
vp env exec --node 22 node node_modules/vitest/vitest.mjs run --project node
echo "==> tests on Node 24 and in Chromium, Firefox and WebKit"
vp env exec --node 24 node node_modules/vitest/vitest.mjs run

sh scripts/check-build.sh
echo "==> all checks passed"
