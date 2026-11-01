// The committed list of coverage-ignore hints in the package source. The
// coverage gate counts the code that a hint skips as covered, so each hint
// needs a listed reason, and the check fails on any hint that the list
// doesn't name.

/** One coverage-ignore hint and why no exit-matrix row can reach the code that it skips. */
export interface CoverageHint {
	/** The source file, relative to the repo root. */
	readonly file: string;
	/** The hint itself, such as `v8 ignore if`. */
	readonly hint: string;
	readonly reason: string;
}

export const coverageHints: readonly CoverageHint[] = [
	{
		file: "packages/ml-dsa/src/core.ts",
		hint: "v8 ignore if",
		reason:
			"each entry hands the module to `initialize` while it evaluates, before any call can run",
	},
];

/** The comment that carries a listed hint in the source. */
export function hintComment({ hint, reason }: CoverageHint): string {
	return `/* ${hint} -- ${reason} */`;
}

// Every hint form that Vitest's V8 coverage provider reads, in a block or a
// line comment.
const hintPattern =
	/\/\*\s*(?:v8|c8|istanbul|node:coverage)\s+ignore\b[\s\S]*?\*\/|\/\/\s*(?:v8|c8|istanbul|node:coverage)\s+ignore\b[^\n]*/gu;

/**
 * Every hint in `sources`, keyed by file, that the list doesn't name, and
 * every listed hint that its file doesn't hold. Each listed hint matches one
 * comment, so a second copy of a hint fails too.
 */
export function hintFailures(
	sources: ReadonlyMap<string, string>,
	listed: readonly CoverageHint[],
): readonly string[] {
	const unmatched = listed.map((entry) => ({ file: entry.file, comment: hintComment(entry) }));
	const failures: string[] = [];
	for (const [file, source] of sources) {
		for (const match of source.matchAll(hintPattern)) {
			const index = unmatched.findIndex(
				(entry) => entry.file === file && entry.comment === match[0],
			);
			if (index === -1) {
				const line = source.slice(0, match.index).split("\n").length;
				failures.push(
					`${file}:${line} holds the hint ${match[0]}, which the list of coverage hints doesn't name with its reason.`,
				);
			} else {
				unmatched.splice(index, 1);
			}
		}
	}
	for (const { file, comment } of unmatched) {
		failures.push(`The list of coverage hints names ${comment}, which ${file} doesn't hold.`);
	}
	return failures;
}
