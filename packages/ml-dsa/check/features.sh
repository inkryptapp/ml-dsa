# The check command's feature probe. The check runs it through
# `scripts/nix shell` in the repo root, with the pinned clang, wasm-ld, llc, and
# wasm-tools on PATH. It assembles each `.wat` fixture in features/ with
# `wasm-tools parse`, then runs each argument:
#
#   MODULE=FEATURES                  validates MODULE with --features=FEATURES.
#                                    MODULE is a fixture's name, or a path that
#                                    holds a slash.
#   witness:NAME:EXPORT=FEATURES     compiles features/NAME.c to assembly with
#                                    each feature in FEATURES, assembles that
#                                    output with the same clang, and links it
#                                    with EXPORT exported.
#
# It prints each result after a section line that starts with "@@":
#
#   llc                              the pinned llc's wasm CPUs and features
#   validate MODULE FEATURES RESULT  the validator's messages, where RESULT is
#                                    passed or failed
#   witness NAME assembly            clang's assembly for features/NAME.c
#   witness NAME module              the linked witness, in base64
#   fixture NAME                     the assembled fixture NAME, in base64
set -euo pipefail

folder=packages/ml-dsa/check/features
out=$(mktemp -d)

# llc prints the list to standard error.
echo "@@ llc"
llc -mtriple=wasm32 -mattr=help 2>&1

for fixture in "$folder"/*.wat; do
	wasm-tools parse "$fixture" -o "$out/$(basename "$fixture" .wat).wasm"
done
# A fixture that the text format can't hold, such as one with an opcode that
# wasm-tools can't decode, is committed as a binary.
cp "$folder"/*.wasm "$out"

for run in "$@"; do
	target=${run%%=*}
	features=${run#*=}
	case $target in
	witness:*)
		name=${target#witness:}
		name=${name%%:*}
		flags=(--target=wasm32-unknown-unknown -mcpu=mvp)
		for feature in ${features//,/ }; do
			flags+=("-m$feature")
		done
		clang "${flags[@]}" -O2 -S "$folder/$name.c" -o "$out/$name.s"
		clang "${flags[@]}" -c "$out/$name.s" -o "$out/$name.o"
		wasm-ld --no-entry "--export=${target##*:}" --strip-all "$out/$name.o" -o "$out/$name.witness.wasm"
		echo "@@ witness $name assembly"
		cat "$out/$name.s"
		echo "@@ witness $name module"
		base64 -w 0 "$out/$name.witness.wasm"
		echo
		echo "@@ fixture $name"
		base64 -w 0 "$out/$name.wasm"
		echo
		;;
	*)
		case $target in
		*/*) file=$target ;;
		*) file=$out/$target.wasm ;;
		esac
		result=passed
		wasm-tools validate "--features=$features" "$file" >"$out/validate.log" 2>&1 || result=failed
		echo "@@ validate $target $features $result"
		cat "$out/validate.log"
		;;
	esac
done
