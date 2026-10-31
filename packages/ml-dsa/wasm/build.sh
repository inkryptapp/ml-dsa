# Compiles mldsa-native to one wasm32 module that holds ML-DSA-44, ML-DSA-65,
# and ML-DSA-87, then links the same objects twice: the shipped module, and an
# unstripped twin that keeps the name section. flake.nix runs this file with
# bash as the Nix builder, which is why it has no shebang. It reads every input
# from the derivation's environment:
#
#   CC, WASM_LD    the unwrapped clang and wasm-ld
#   MLDSA_NATIVE   the vendored source, upstream's files at the pin
#   INCLUDE        the root that holds the config header and the shim folder
#   MEMORY_SIZE    the linear memory size in bytes, from sizes.json
#   STACK_SIZE     the wasm stack size in bytes, from sizes.json
#   out            the output folder
#
# Every compiler and linker flag lives in this file. Records 0001 to 0003 in
# docs/adr/ hold the reasons.
set -euo pipefail

for size in "$MEMORY_SIZE" "$STACK_SIZE"; do
	case $size in
	'' | *[!0-9]*)
		echo "build.sh: MEMORY_SIZE and STACK_SIZE must hold only digits, but one is '$size'." >&2
		exit 1
		;;
	esac
done

# One name gives both the namespace and the export names.
namespace=mldsa

# The maps give each root that the compile reads a stable name, so that neither
# __FILE__ nor the debug info of a -g build names a build folder or a store
# path. The shim folder sits inside INCLUDE, so it gets no map of its own.
prefix_maps=(
	"-ffile-prefix-map=$PWD=build"
	"-ffile-prefix-map=$MLDSA_NATIVE=mldsa-native"
	"-ffile-prefix-map=$INCLUDE=include"
	"-ffile-prefix-map=$("$CC" -print-resource-dir)=clang"
)

cflags=(
	--target=wasm32-unknown-unknown -mcpu=mvp -mbulk-memory-opt
	-O3 -std=c99 -pedantic
	# Upstream's test warning flags, from test/mk/config.mk at the pin.
	-Wall -Wextra -Werror=unused-result -Wpedantic -Werror
	-Wmissing-prototypes -Wshadow -Wpointer-arith -Wredundant-decls
	-Wconversion -Wsign-conversion -Wno-long-long -Wno-unknown-pragmas
	-Wno-unused-command-line-argument
	-nostdlibinc -isystem "$INCLUDE/shim"
	-I"$INCLUDE" -I"$MLDSA_NATIVE/mldsa"
	'-DMLD_CONFIG_FILE="mldsa_wasm_config.h"'
	"-DMLD_CONFIG_NAMESPACE_PREFIX=$namespace"
	"${prefix_maps[@]}"
)

# A fixed list, so the link order never depends on a folder listing.
sources=(
	src/ct.c src/debug.c src/fips202/fips202.c src/fips202/fips202x4.c
	src/fips202/keccakf1600.c src/packing.c src/poly.c src/poly_kl.c
	src/polyvec.c src/polyvec_lazy.c src/sign.c
)
parameter_sets=(44 65 87)

objects=()
for parameter_set in "${parameter_sets[@]}"; do
	if [ "$parameter_set" = 44 ]; then
		shared=-DMLD_CONFIG_MULTILEVEL_WITH_SHARED
	else
		shared=-DMLD_CONFIG_MULTILEVEL_NO_SHARED
	fi
	for source in "${sources[@]}"; do
		object=obj/$parameter_set/${source%.c}.o
		mkdir -p "$(dirname "$object")"
		"$CC" "${cflags[@]}" "-DMLD_CONFIG_PARAMETER_SET=$parameter_set" "$shared" \
			-c "$MLDSA_NATIVE/mldsa/$source" -o "$object"
		objects+=("$object")
	done
done

# wasm-ld exports the memory as `memory` on its own.
exports=(__stack_low __stack_high __heap_base __heap_end)
for parameter_set in "${parameter_sets[@]}"; do
	for function in keypair_internal signature_internal verify_extmu; do
		exports+=("$namespace${parameter_set}_$function")
	done
done
# The domain-separation prefix doesn't depend on the parameter set, so one copy
# serves all three.
exports+=("${namespace}44_prepare_domain_separation_prefix")
for function in init absorb finalize squeeze release; do
	exports+=("${namespace}_shake256_$function")
done

link_flags=(
	--no-entry --stack-first
	-z "stack-size=$STACK_SIZE" "--initial-memory=$MEMORY_SIZE" --no-growable-memory
	--keep-section=producers --keep-section=target_features
)
for export in "${exports[@]}"; do
	link_flags+=("--export=$export")
done

mkdir -p "$out"
"$WASM_LD" "${link_flags[@]}" --strip-all -o "$out/mldsa.wasm" "${objects[@]}"
"$WASM_LD" "${link_flags[@]}" -o "$out/mldsa.unstripped.wasm" "${objects[@]}"
