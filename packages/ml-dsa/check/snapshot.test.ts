import { describe, expect, test } from "vite-plus/test";

import { fileLines, snapshotFailures } from "./snapshot.ts";

const hint =
	"If the change is intended, review it, then make list.txt hold exactly the lines that the probe gives.";

function compare(committed: string | undefined, actual: readonly string[]): readonly string[] {
	return snapshotFailures("list.txt", "the probe", committed, actual);
}

describe("snapshotFailures", () => {
	test("passes when the file holds exactly the lines, ending in a newline", () => {
		expect(compare("a\nb\n", ["a", "b"])).toStrictEqual([]);
	});

	test("names each line that only one side holds, as often as it differs", () => {
		expect(compare("a\nb\nb\nc\n", ["a", "b", "d", "d"])).toStrictEqual([
			"list.txt lacks the line `d`, which the probe gives.",
			"list.txt lacks the line `d`, which the probe gives.",
			"list.txt has the line `b`, which the probe doesn't give.",
			"list.txt has the line `c`, which the probe doesn't give.",
			hint,
		]);
	});

	test("fails when the same lines come in another order", () => {
		expect(compare("b\na\n", ["a", "b"])).toStrictEqual([
			"list.txt holds the lines that the probe gives, in another order.",
			hint,
		]);
	});

	test("fails on an empty line that the lines don't hold", () => {
		expect(compare("a\n\n", ["a"])).toStrictEqual([
			"list.txt has the line ``, which the probe doesn't give.",
			hint,
		]);
	});

	test("fails when the file is missing", () => {
		expect(compare(undefined, ["a"])).toStrictEqual([`The repo has no list.txt. ${hint}`]);
	});
});

describe("fileLines", () => {
	test("drops only the empty line after the last newline", () => {
		expect(fileLines("a\nb\n")).toStrictEqual(["a", "b"]);
		expect(fileLines("a\nb")).toStrictEqual(["a", "b"]);
		expect(fileLines("")).toStrictEqual([]);
	});
});
