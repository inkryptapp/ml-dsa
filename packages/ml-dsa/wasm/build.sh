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
# With the argument `probe`, the file runs the check command's probes of
# upstream's headers instead, with the same flags. The probe function below
# says how.
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
	"${prefix_maps[@]}"
)

# The shipped config, which the check command's config diff compares with
# upstream's CT config.
config=(
	'-DMLD_CONFIG_FILE="mldsa_wasm_config.h"'
	"-DMLD_CONFIG_NAMESPACE_PREFIX=$namespace"
)

# A fixed list, so the link order never depends on a folder listing.
sources=(
	src/ct.c src/debug.c src/fips202/fips202.c src/fips202/fips202x4.c
	src/fips202/keccakf1600.c src/packing.c src/poly.c src/poly_kl.c
	src/polyvec.c src/polyvec_lazy.c src/sign.c
)
parameter_sets=(44 65 87)

# Sets object_flags to the compiler flags of one parameter set's objects. Only
# the ML-DSA-44 objects hold the code that the parameter sets share.
set_object_flags() {
	local shared=-DMLD_CONFIG_MULTILEVEL_NO_SHARED
	if [ "$1" = 44 ]; then
		shared=-DMLD_CONFIG_MULTILEVEL_WITH_SHARED
	fi
	object_flags=("${cflags[@]}" "${config[@]}" "-DMLD_CONFIG_PARAMETER_SET=$1" "$shared")
}

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

build() {
	local objects=() parameter_set source object
	for parameter_set in "${parameter_sets[@]}"; do
		set_object_flags "$parameter_set"
		for source in "${sources[@]}"; do
			object=obj/$parameter_set/${source%.c}.o
			mkdir -p "$(dirname "$object")"
			"$CC" "${object_flags[@]}" -c "$MLDSA_NATIVE/mldsa/$source" -o "$object"
			objects+=("$object")
		done
	done

	local link_flags=(
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
}

# Compiles the probe file named by the first argument with the object flags
# of the parameter set in the second, under -fsyntax-only. Then it prints a
# section line with the result, followed by clang's messages.
probe_layout() {
	local section=$1 parameter_set=$2 status=passed
	set_object_flags "$parameter_set"
	"$CC" "${object_flags[@]}" -Wno-c11-extensions -fsyntax-only "$out/$section.c" \
		>"$out/$section.log" 2>&1 || status=failed
	echo "@@ $section $parameter_set $status"
	cat "$out/$section.log"
}

# The check command runs this mode through `scripts/nix shell`, with the
# pinned clang as CC and the working tree's files as MLDSA_NATIVE and
# INCLUDE. It takes the layout probe's _Static_assert lines, a line that must
# fail, and then the -D definitions of upstream's CT config, which the check
# reads from upstream's CT workflow and action. That config adds them to
# upstream's default config. MLD_CONFIG_CT_TESTING_ENABLED makes upstream
# include valgrind/memcheck.h, so the probe gives it an empty stub. It prints
# each probe's output after a section line that starts with "@@":
#
#   prototypes N             each export's declaration in upstream's headers
#   layout N RESULT          clang's messages for the layout probe
#   config N                 the macros under the shipped config
#   config ct                the macros under upstream's CT config, once
#   failing-layout 44 RESULT clang's messages for the failing line, once
#
# N is each parameter set, and each compile takes that parameter set's object
# flags. RESULT is passed or failed.
probe() {
	local layout_lines=$1 failing_line=$2 parameter_set name
	shift 2
	local ct_config=("$@")
	out=$(mktemp -d)
	mkdir -p "$out/stub/valgrind"
	: >"$out/stub/valgrind/memcheck.h"
	printf '%s\n' '#include "src/sign.h"' '#include "src/fips202/fips202.h"' >"$out/headers.c"
	printf '%s\n' '#include "src/common.h"' >"$out/config.c"
	printf '%s\n' "$layout_lines" | cat "$out/headers.c" - >"$out/layout.c"
	printf '%s\n' "$failing_line" | cat "$out/headers.c" - >"$out/failing-layout.c"

	for parameter_set in "${parameter_sets[@]}"; do
		set_object_flags "$parameter_set"
		echo "@@ prototypes $parameter_set"
		for name in "${exports[@]}"; do
			case $name in
			__*) ;;
			*)
				"$CC" "${object_flags[@]}" -fsyntax-only -Xclang -ast-print \
					-Xclang -ast-dump-filter -Xclang "$name" "$out/headers.c"
				;;
			esac
		done
		probe_layout layout "$parameter_set"
		echo "@@ config $parameter_set"
		"$CC" "${object_flags[@]}" -dM -E "$out/config.c"
	done
	echo "@@ config ct"
	"$CC" "${cflags[@]}" "${ct_config[@]}" -isystem "$out/stub" -dM -E "$out/config.c"
	probe_layout failing-layout 44
}

case ${1-build} in
build) build ;;
probe)
	shift
	probe "$@"
	;;
*)
	echo "build.sh: the only arguments are none, which builds the module, and probe." >&2
	exit 1
	;;
esac
