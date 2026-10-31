/**
 * The Nix sandbox is off inside the build container, so nothing stops the
 * build from reading the container's own files. These rules keep the build
 * script and the derivation from naming a path outside `/nix/store`.
 *
 * The build script must pass an allowlist. Each word is read without the
 * quoting that bash removes. Each slash in the word follows a letter, a digit,
 * or `_`, as in `obj/44`. Only `$out`, `$INCLUDE`, `$MLDSA_NATIVE`, and
 * `$parameter_set` may come before a slash. No word holds `~`, ends in a
 * backslash, uses `$'…'` quoting or a brace expansion, joins a path to an
 * option, or climbs with `..`, written out or through a glob. A lone `\` that
 * continues a line is not a word.
 *
 * The derivation must name no absolute path outside `/nix/store` and no
 * relative `..` climb.
 *
 * The rules catch the paths that an author writes by mistake, such as
 * `-I/usr/include` or `$HOME/x`. They read only the text, so a script written
 * to evade them can still build a path at run time, for example by emptying,
 * slicing, or splitting one of the four variables, or with a command such as
 * `$(printf '\057etc')`. Review covers that. The rules also reject some
 * harmless text.
 */
import { posix } from "node:path";

/** The only folder that an absolute path in the build may name. */
const store = "/nix/store";

const hazard =
	"The build container has no Nix sandbox, so the build would read the container's own files.";

/** A slash after anything but a letter, a digit, or `_`, which can start an absolute path. */
const unsafeSlash = /(?<![A-Za-z0-9_])\//;

/** An option with a path joined to it, as in `-I/usr/include`. */
const joinedOption = /-\w+\//;

/**
 * The quoting that bash removes when it joins a word, so `.''.` reads as `..`
 * and `-"I/usr"` as `-I/usr`. A `$` before a double quote goes too, for
 * `$"…"`.
 */
const quoting = /\$?"|['\\]/g;

/**
 * A brace expansion, which bash splits into one word per part, as in
 * `{a,}/etc` for `a/etc` and `/etc`. A `${` starts a parameter expansion.
 */
const braceExpansion = /(?<!\$)\{/;

/**
 * A `.` next to a glob or extended-glob character, which a glob can expand to
 * `..`, as in `.?`, `.[.]`, `.@(.)`, or `@(x|.|y)@(x|.|y)`.
 */
const globClimb = /\.[?*[\]()@+!|]|[?*[\]()@+!|]\./;

/**
 * The variables that build.sh may put right before a slash: the derivation's
 * `out`, `INCLUDE`, and `MLDSA_NATIVE`, which hold store paths, and the
 * script's own `parameter_set`. Another variable can be empty or split the
 * word, as `$_` and `$IFS` can, which leaves the slash at the start of a path.
 * It can also hold a path outside `/nix/store`, as `$HOME` does.
 */
const pathVariables: ReadonlySet<string> = new Set([
	"out",
	"INCLUDE",
	"MLDSA_NATIVE",
	"parameter_set",
]);

/** The names in {@link pathVariables}, as a message lists them. */
const pathVariableList = new Intl.ListFormat("en").format(
	[...pathVariables].map((name) => `$${name}`),
);

/** A `$name` right before a slash, with the name as its group. */
const variableBeforeSlash = /\$(\w+)\//g;

/** Returns why one word of the build script breaks the allowlist, if it does. */
function scriptWordFailure(word: string): string | undefined {
	// The lint reads one line at a time, so a line break must not split a word.
	// A lone backslash after a space continues the line between two words.
	if (word !== "\\" && word.endsWith("\\")) {
		return "which ends in a backslash. Put a space before a backslash that continues a line, so the line break can't split a word.";
	}
	if (word.includes("~")) {
		return "which bash can expand to a home folder.";
	}
	// An escape in `$'…'` can build a slash, as `$'\x2f'` does, or expand to
	// nothing, as `$'\0'` does, so the unquoted word can't show what bash reads.
	if (word.includes("$'")) {
		return "which uses $'…' quoting, whose escapes the lint can't read.";
	}
	const unquoted = word.replace(quoting, "");
	if (braceExpansion.test(unquoted)) {
		return "which bash splits into words through a brace expansion that the lint can't follow.";
	}
	if (unquoted.includes("..")) {
		return 'which climbs with "..".';
	}
	if (globClimb.test(unquoted)) {
		return 'which a glob can expand to "..".';
	}
	if (joinedOption.test(unquoted)) {
		return 'which joins a path to an option. Pass the path as its own word, as in "-I dir".';
	}
	if (unsafeSlash.test(unquoted)) {
		return 'where a slash doesn\'t follow a letter, a digit, or "_", so it can start an absolute path.';
	}
	for (const [, name = ""] of unquoted.matchAll(variableBeforeSlash)) {
		if (!pathVariables.has(name)) {
			return `where a slash follows $${name}, which can be empty, split the word, or hold a path outside ${store}. Only ${pathVariableList} may come before a slash.`;
		}
	}
	return undefined;
}

/**
 * Returns the messages for the build script's text. The script has no
 * shebang, because the derivation names its interpreter, and each of its
 * words passes the allowlist. Each word that fails gets one message, which
 * names its line and the first rule it breaks.
 */
export function buildScriptFailures(file: string, text: string): readonly string[] {
	const failures: string[] = [];
	if (text.startsWith("#!")) {
		failures.push(
			`${file} starts with a shebang. The derivation picks the interpreter, the store's bash, so a shebang has no effect and can only name the wrong one.`,
		);
	}
	text.split("\n").forEach((line, index) => {
		for (const word of new Set(line.split(/\s+/))) {
			const reason = scriptWordFailure(word);
			if (reason !== undefined) {
				failures.push(`${file}:${String(index + 1)} has \`${word}\`, ${reason} ${hazard}`);
			}
		}
	});
	return failures;
}

/** The characters that end a path in a derivation value. */
const delimiters = /[\s"'`,;:()[\]{}<>|&=]+/;

/**
 * A slash inside a token that starts a path. That is a slash after any
 * character except a word character or `.`, such as the `-` of `x-/data`.
 * The two exceptions keep `obj/44` and `./x` relative.
 */
const pathStart = /(?<![\w.])\//;

/** A `..` before a slash or at the end of a token, as in `../x` or `-I..`. */
const climb = /\.\.(?:\/|$)/;

/**
 * Returns the path in a token of a derivation value, if it holds one. A token
 * that starts with a slash or a tilde is one path, `/` and `//etc` included.
 * In a token that starts with `-`, the first slash starts a path, because a
 * compiler or linker option can take its path joined, as in
 * `-iframework/data`. Elsewhere, a path starts at the first slash that
 * {@link pathStart} matches. A token that climbs with `..` before that slash
 * counts whole.
 */
function pathIn(token: string): string | undefined {
	if (token.startsWith("/") || token.startsWith("~")) {
		return token;
	}
	const start = token.startsWith("-") ? token.indexOf("/") : (pathStart.exec(token)?.index ?? -1);
	if (climb.test(start === -1 ? token : token.slice(0, start))) {
		return token;
	}
	return start === -1 ? undefined : token.slice(start);
}

/** Normalizing first resolves `..` segments, so `/nix/store/../etc` counts as `/etc`. */
function isInStore(path: string): boolean {
	const normalized = posix.normalize(path);
	return normalized === store || normalized.startsWith(`${store}/`);
}

function keysAndStrings(value: unknown): readonly string[] {
	if (typeof value === "string") {
		return [value];
	}
	if (Array.isArray(value)) {
		return value.flatMap(keysAndStrings);
	}
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).flatMap(([key, item]) => [key, ...keysAndStrings(item)]);
	}
	return [];
}

/**
 * Returns one message per path outside `/nix/store` in the output of
 * `nix derivation show`, once each. It reads every key and every string
 * value, so it doesn't depend on the JSON format of one Nix version.
 */
export function derivationFailures(derivations: unknown): readonly string[] {
	const paths = new Set<string>();
	for (const token of keysAndStrings(derivations).flatMap((text) => text.split(delimiters))) {
		const path = pathIn(token);
		if (path !== undefined && !isInStore(path)) {
			paths.add(path);
		}
	}
	return [...paths].map(
		(path) => `The derivation names ${path}, which is outside ${store}. ${hazard}`,
	);
}
