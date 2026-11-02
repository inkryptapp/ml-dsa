# Packs the npm tarball inside the build container, and writes the tarball to
# standard output. Every other line of output goes to standard error. The
# check command runs it in the repo root with the flake's Node.js and pnpm on
# PATH:
#
#   bash packages/ml-dsa/check/pack.sh WORK FILE...
#
# WORK is a folder inside the container that the script empties and then
# uses. Each FILE is a path, relative to the repo root, of a file that the
# install and the pack may read. The script copies them into WORK, so the
# install never writes the host's node_modules.
set -euo pipefail

work=$1
shift

rm -rf "$work"
mkdir -p "$work/repo" "$work/out"
tar -cf - -- "$@" | tar -xf - -C "$work/repo"

# The package store lives in the container's /root/.cache volume, which
# persists between runs.
cd "$work/repo"
pnpm install --frozen-lockfile --ignore-scripts \
	--store-dir "$HOME/.cache/ml-dsa-pnpm-store" >&2

cd packages/ml-dsa
# pnpm's bin shims need sed, which the build image lacks.
node ../../node_modules/vite-plus/bin/vp pack >&2
npm_config_update_notifier=false npm pack --ignore-scripts --pack-destination "$work/out" >&2

tarballs=("$work"/out/*.tgz)
if [ "${#tarballs[@]}" -ne 1 ]; then
	echo "pack.sh: npm pack wrote ${#tarballs[@]} tarballs instead of one." >&2
	exit 1
fi
cat "${tarballs[0]}"
