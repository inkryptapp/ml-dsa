#!/bin/sh
# Compile mldsa-native's single-unit build and the C shim to a freestanding
# wasm32 module. Every compile and link flag is here (ADR 0001).
#
#   MLDSA_SRC  upstream's mldsa/ directory
#   OUT        output .wasm path
#
# Expects the unwrapped clang and wasm-ld of the Matched toolchain on PATH.
set -eu

: "${MLDSA_SRC:?}" "${OUT:?}"
cd "$(dirname "$0")"

CFLAGS="--target=wasm32-unknown-unknown -O3 -mcpu=mvp -mbulk-memory
  -std=c99 -ffreestanding -nostdlib -nostdlibinc
  -Wall -Wextra -Wpedantic -Werror
  -I. -isystem include -I$MLDSA_SRC
  -DMLD_CONFIG_FILE=\"mldsa87_config.h\""

# The stack comes first so that an overflow traps instead of running into
# data. --strip-all also drops the name section, which would record the output
# file name. Never pass --allow-undefined: an implicit memcpy must fail the
# link (ADR 0005).
LDFLAGS="--no-entry
  --export=__heap_base --export=__stack_low --export=__stack_high
  -z stack-size=262144 --stack-first
  --strip-all --keep-section=producers --keep-section=target_features"

clang --version
# CFLAGS and LDFLAGS each hold several flags, so they stay unquoted to split into words.
# shellcheck disable=SC2086
clang $CFLAGS -c "$MLDSA_SRC/mldsa_native.c" -o mldsa_native.o
# shellcheck disable=SC2086
clang $CFLAGS -c shim.c -o shim.o
# shellcheck disable=SC2086
wasm-ld $LDFLAGS mldsa_native.o shim.o -o "$OUT"
