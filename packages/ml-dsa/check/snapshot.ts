/**
 * Compares the lines that a check computes with a committed file of expected
 * lines. A difference fails until someone reviews it and updates the file.
 */

function counts(lines: readonly string[]): Map<string, number> {
	const result = new Map<string, number>();
	for (const line of lines) {
		result.set(line, (result.get(line) ?? 0) + 1);
	}
	return result;
}

/**
 * The lines of `lines` that `other` doesn't hold, counting repeats. A line
 * that `lines` holds three times and `other` once appears twice.
 */
function surplus(lines: readonly string[], other: readonly string[]): readonly string[] {
	const remaining = counts(other);
	return lines.filter((line) => {
		const left = remaining.get(line) ?? 0;
		remaining.set(line, left - 1);
		return left <= 0;
	});
}

/** Splits a committed file into its lines, without the newline that ends the last one. */
export function fileLines(text: string): readonly string[] {
	const lines = text.split("\n");
	return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

/**
 * Returns the messages for the lines that `subject` gives, `actual`, against
 * `committed`, the text of `file`, which is `undefined` when the file is
 * missing. Each line that only one side holds gets one message. If both hold
 * the same lines in another order, one message says so. A last message says
 * how to accept the change.
 */
export function snapshotFailures(
	file: string,
	subject: string,
	committed: string | undefined,
	actual: readonly string[],
): readonly string[] {
	const hint = `If the change is intended, review it, then make ${file} hold exactly the lines that ${subject} gives.`;
	if (committed === undefined) {
		return [`The repo has no ${file}. ${hint}`];
	}
	const expected = fileLines(committed);
	if (
		expected.length === actual.length &&
		expected.every((line, index) => line === actual[index])
	) {
		return [];
	}
	const failures = [
		...surplus(actual, expected).map(
			(line) => `${file} lacks the line \`${line}\`, which ${subject} gives.`,
		),
		...surplus(expected, actual).map(
			(line) => `${file} has the line \`${line}\`, which ${subject} doesn't give.`,
		),
	];
	if (failures.length === 0) {
		failures.push(`${file} holds the lines that ${subject} gives, in another order.`);
	}
	return [...failures, hint];
}
