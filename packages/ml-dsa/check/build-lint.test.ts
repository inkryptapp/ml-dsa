import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { buildScriptFailures, derivationFailures } from "./build-lint.ts";

const storePath = "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-coreutils-9.7";

const hazard =
	"The build container has no Nix sandbox, so the build would read the container's own files.";

/** The message that `buildScriptFailures` gives for the word `text` on line `line` of `build.sh`. */
function wordFailure(line: number, text: string, reason: string): string {
	return `build.sh:${String(line)} has \`${text}\`, ${reason} ${hazard}`;
}

const slash =
	'where a slash doesn\'t follow a letter, a digit, or "_", so it can start an absolute path.';
const climb = 'which climbs with "..".';
const option = 'which joins a path to an option. Pass the path as its own word, as in "-I dir".';
const tilde = "which bash can expand to a home folder.";
const glob = 'which a glob can expand to "..".';
const brace = "which bash splits into words through a brace expansion that the lint can't follow.";
const ansi = "which uses $'…' quoting, whose escapes the lint can't read.";
function variable(name: string): string {
	return `where a slash follows $${name}, which can be empty, split the word, or hold a path outside /nix/store. Only $out, $INCLUDE, $MLDSA_NATIVE, and $parameter_set may come before a slash.`;
}
const backslash =
	"which ends in a backslash. Put a space before a backslash that continues a line, so the line break can't split a word.";

/** The message that `derivationFailures` gives for `path`. */
function outsideDerivation(path: string): string {
	return `The derivation names ${path}, which is outside /nix/store. ${hazard}`;
}

/** Lints `lines` as the build script `build.sh`. */
function lint(...lines: readonly string[]): readonly string[] {
	return buildScriptFailures("build.sh", lines.join("\n"));
}

describe("buildScriptFailures", () => {
	test("passes the committed build script", () => {
		const file = "packages/ml-dsa/wasm/build.sh";
		const text = readFileSync(join(root, file), "utf8");
		expect(buildScriptFailures(file, text)).toStrictEqual([]);
	});

	test("passes a script whose every slash follows a name", () => {
		expect(
			lint(
				"set -eu",
				'mkdir -p "$out" "$(dirname "$object")"',
				'cp obj/44/a.o $out/a.o "$MLDSA_NATIVE/mldsa/$source"',
				'-I"$INCLUDE" -isystem "$INCLUDE/shim" docs/adr/ mldsa-native',
			),
		).toStrictEqual([]);
	});

	test("rejects a shebang, and names the line and the word of each failure", () => {
		expect(lint("#!/bin/bash", "set -eu", "cp /tmp/x $out")).toStrictEqual([
			"build.sh starts with a shebang. The derivation picks the interpreter, the store's bash, so a shebang has no effect and can only name the wrong one.",
			wordFailure(1, "#!/bin/bash", slash),
			wordFailure(3, "/tmp/x", slash),
		]);
	});

	test("rejects every slash that doesn't follow a name", () => {
		expect(
			lint(
				"cat /etc/passwd //etc/hosts / \\/x @/x",
				`cat "/data" '/data' x=/data PATH=a:/data`,
				"cat ${X:-/data} ${X+/data} 3<>/dev/tcp/x/80 2>/tmp/log|/bin/tee cat${IFS}/etc/x",
				"curl https://cache.nixos.org/x",
				"echo $(( 6 / 2 ))",
			),
		).toStrictEqual([
			wordFailure(1, "/etc/passwd", slash),
			wordFailure(1, "//etc/hosts", slash),
			wordFailure(1, "/", slash),
			wordFailure(1, "\\/x", slash),
			wordFailure(1, "@/x", slash),
			wordFailure(2, '"/data"', slash),
			wordFailure(2, "'/data'", slash),
			wordFailure(2, "x=/data", slash),
			wordFailure(2, "PATH=a:/data", slash),
			wordFailure(3, "${X:-/data}", slash),
			wordFailure(3, "${X+/data}", slash),
			wordFailure(3, "3<>/dev/tcp/x/80", slash),
			wordFailure(3, "2>/tmp/log|/bin/tee", slash),
			wordFailure(3, "cat${IFS}/etc/x", slash),
			wordFailure(4, "https://cache.nixos.org/x", slash),
			wordFailure(5, "/", slash),
		]);
	});

	test("rejects a path joined to any option", () => {
		expect(
			lint(
				"cc -I/usr/include -iframework/data -MJ/data/c.json -Iinclude/shim x=-L/lib",
				`cc -"I/usr" -\\I/usr -''I/usr`,
			),
		).toStrictEqual([
			wordFailure(1, "-I/usr/include", option),
			wordFailure(1, "-iframework/data", option),
			wordFailure(1, "-MJ/data/c.json", option),
			wordFailure(1, "-Iinclude/shim", option),
			wordFailure(1, "x=-L/lib", option),
			wordFailure(2, '-"I/usr"', option),
			wordFailure(2, "-\\I/usr", option),
			wordFailure(2, "-''I/usr", option),
		]);
	});

	test("rejects a `..` climb, even when quotes split it", () => {
		expect(
			lint(
				"cc -I.. -L../lib @../x ../z $out/../y",
				`cat /nix/store/.''./etc /nix/store/."./."./etc`,
				`cd .$"." .$"".`,
			),
		).toStrictEqual([
			wordFailure(1, "-I..", climb),
			wordFailure(1, "-L../lib", climb),
			wordFailure(1, "@../x", climb),
			wordFailure(1, "../z", climb),
			wordFailure(1, "$out/../y", climb),
			wordFailure(2, "/nix/store/.''./etc", climb),
			wordFailure(2, '/nix/store/."./."./etc', climb),
			wordFailure(3, '.$"."', climb),
			wordFailure(3, '.$"".', climb),
		]);
	});

	test("rejects `$'…'` quoting, whose escapes can build a slash or expand to nothing", () => {
		expect(
			lint(
				"cat $'\\0'/etc/passwd <$'\\x00'/etc/hosts $'\\x2fetc\\x2fpasswd' $'/data'",
				"exec 3<>$'\\0'/dev/tcp/x/80",
				"cc -$'I/usr' && cd .$'.' $'.'$'.' .$''.",
			),
		).toStrictEqual([
			wordFailure(1, "$'\\0'/etc/passwd", ansi),
			wordFailure(1, "<$'\\x00'/etc/hosts", ansi),
			wordFailure(1, "$'\\x2fetc\\x2fpasswd'", ansi),
			wordFailure(1, "$'/data'", ansi),
			wordFailure(2, "3<>$'\\0'/dev/tcp/x/80", ansi),
			wordFailure(3, "-$'I/usr'", ansi),
			wordFailure(3, ".$'.'", ansi),
			wordFailure(3, "$'.'$'.'", ansi),
			wordFailure(3, ".$''.", ansi),
		]);
	});

	test("rejects a slash after any variable but the build's own four", () => {
		expect(
			lint(
				"cat $IFS/etc/passwd x$IFS/etc $_/etc $1/etc $HOME/x exec 3<$IFS/etc/hosts",
				'cp "$out/x" $INCLUDE/x "$MLDSA_NATIVE/mldsa/$source" obj/$parameter_set/x',
			),
		).toStrictEqual([
			wordFailure(1, "$IFS/etc/passwd", variable("IFS")),
			wordFailure(1, "x$IFS/etc", variable("IFS")),
			wordFailure(1, "$_/etc", variable("_")),
			wordFailure(1, "$1/etc", variable("1")),
			wordFailure(1, "$HOME/x", variable("HOME")),
			wordFailure(1, "3<$IFS/etc/hosts", variable("IFS")),
		]);
	});

	test("rejects a brace expansion, but not a parameter expansion or a lone brace", () => {
		expect(
			lint(
				"cat {a,}/etc/passwd {,a}/etc {x,/}etc {a,{b,}}/etc {a,'/'}etc a{/,}b",
				"cc -isystem {x,/}usr/include .{a,.}{b,/}.{c,.}{d,/}etc{e,/}passwd -{,}I/usr .{,}./etc",
				'echo "${cflags[@]}" "$namespace${parameter_set}_$function"',
				"build() {",
				"}",
			),
		).toStrictEqual([
			wordFailure(1, "{a,}/etc/passwd", brace),
			wordFailure(1, "{,a}/etc", brace),
			wordFailure(1, "{x,/}etc", brace),
			wordFailure(1, "{a,{b,}}/etc", brace),
			wordFailure(1, "{a,'/'}etc", brace),
			wordFailure(1, "a{/,}b", brace),
			wordFailure(2, "{x,/}usr/include", brace),
			wordFailure(2, ".{a,.}{b,/}.{c,.}{d,/}etc{e,/}passwd", brace),
			wordFailure(2, "-{,}I/usr", brace),
			wordFailure(2, ".{,}./etc", brace),
		]);
	});

	test("rejects a `.` next to a glob character, which can expand to `..`", () => {
		expect(lint("cd .[.] .? ?. .* .@(.) .+(.) .!(x) @(x|.|y)@(x|.|y)")).toStrictEqual([
			wordFailure(1, ".[.]", glob),
			wordFailure(1, ".?", glob),
			wordFailure(1, "?.", glob),
			wordFailure(1, ".*", glob),
			wordFailure(1, ".@(.)", glob),
			wordFailure(1, ".+(.)", glob),
			wordFailure(1, ".!(x)", glob),
			wordFailure(1, "@(x|.|y)@(x|.|y)", glob),
		]);
	});

	test("rejects a word that ends in a backslash, even in a comment", () => {
		expect(
			lint("cc -I.\\", ".", "# see the notes\\", "/bin/echo x", "cc \\", "  -c x.c"),
		).toStrictEqual([
			wordFailure(1, "-I.\\", backslash),
			wordFailure(3, "notes\\", backslash),
			wordFailure(4, "/bin/echo", slash),
		]);
	});

	test("rejects a tilde", () => {
		expect(lint("cat ~/x ~root PATH=~/bin")).toStrictEqual([
			wordFailure(1, "~/x", tilde),
			wordFailure(1, "~root", tilde),
			wordFailure(1, "PATH=~/bin", tilde),
		]);
	});
});

describe("derivationFailures", () => {
	test("passes a derivation that names only store paths", () => {
		const derivation = {
			[`${storePath}.drv`]: {
				args: [`${storePath}-build.sh`],
				builder: `${storePath}/bin/bash`,
				env: { PATH: `${storePath}/bin`, allowedReferences: "", MEMORY_SIZE: "327680" },
			},
		};
		expect(derivationFailures(derivation)).toStrictEqual([]);
	});

	test("rejects a URL, and finds the paths that follow it", () => {
		expect(
			derivationFailures({
				env: { X: "https://example.com;cat</etc/passwd", PATH: "https://example.com:/usr/bin" },
			}),
		).toStrictEqual([
			outsideDerivation("//example.com"),
			outsideDerivation("/etc/passwd"),
			outsideDerivation("/usr/bin"),
		]);
	});

	test("rejects a path that climbs out of the store, a near miss of its name, and a relative climb", () => {
		expect(
			derivationFailures({
				env: {
					A: "/nix/store/../../etc/passwd",
					B: "/nix/store/x/../../../bin/sh",
					C: "/nix/storefront /nix",
					D: "-I.. ../z x/../../srv @../args.rsp",
				},
			}),
		).toStrictEqual([
			outsideDerivation("/nix/store/../../etc/passwd"),
			outsideDerivation("/nix/store/x/../../../bin/sh"),
			outsideDerivation("/nix/storefront"),
			outsideDerivation("/nix"),
			outsideDerivation("-I.."),
			outsideDerivation("../z"),
			outsideDerivation("x/../../srv"),
			outsideDerivation("@../args.rsp"),
		]);
	});

	test("finds a path joined to any option, after any other character, or by tilde", () => {
		expect(
			derivationFailures({
				env: { X: "-iframework/data/x -MJ/data/c.json x-/data/y a:+/data/z ~/w" },
			}),
		).toStrictEqual([
			outsideDerivation("/data/x"),
			outsideDerivation("/data/c.json"),
			outsideDerivation("/data/y"),
			outsideDerivation("/data/z"),
			outsideDerivation("~/w"),
		]);
	});

	test("finds paths in nested values and in keys, once each", () => {
		const derivation = {
			derivations: {
				"x.drv": {
					env: { HOME: "/root", CFLAGS: "-I/usr/include", LDFLAGS: "-I/usr/include" },
					inputs: { srcs: ["/build/source"], drvs: { "/tmp/y.drv": { outputs: [1, null] } } },
				},
			},
		};
		expect(derivationFailures(derivation)).toStrictEqual([
			outsideDerivation("/root"),
			outsideDerivation("/usr/include"),
			outsideDerivation("/build/source"),
			outsideDerivation("/tmp/y.drv"),
		]);
	});
});
