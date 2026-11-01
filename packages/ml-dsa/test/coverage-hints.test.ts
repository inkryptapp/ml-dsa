import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { coverageHints, hintComment, hintFailures, type CoverageHint } from "./coverage-hints.js";
import { root } from "./dev-tools.js";

const sourceFolder = "packages/ml-dsa/src";

/** Every TypeScript file of the package source, keyed by its path from the repo root. */
function packageSources(): ReadonlyMap<string, string> {
	const sources = new Map<string, string>();
	for (const entry of readdirSync(join(root, sourceFolder), {
		recursive: true,
		encoding: "utf8",
	})) {
		const file = `${sourceFolder}/${entry}`;
		if (file.endsWith(".ts")) {
			sources.set(file, readFileSync(join(root, file), "utf8"));
		}
	}
	return sources;
}

describe("the list of coverage hints", () => {
	test("names every hint in the package source with its reason, and no other", () => {
		expect(hintFailures(packageSources(), coverageHints)).toStrictEqual([]);
	});

	const listed: CoverageHint = { file: "a.ts", hint: "v8 ignore next", reason: "a reason" };

	test("fails on a hint that it doesn't name, in any form that the coverage provider reads", () => {
		const hints = [
			"/* v8 ignore next */",
			"/* v8 ignore start */",
			"/* c8 ignore next */",
			"/* istanbul ignore else */",
			"/* node:coverage ignore next */",
			"// v8 ignore next",
			"/* v8 ignore next -- another reason */",
		];
		for (const hint of hints) {
			const source = `const a = 1;\n${hint}\nconst b = 2;\n`;
			expect(hintFailures(new Map([["a.ts", source]]), [])).toStrictEqual([
				`a.ts:2 holds the hint ${hint}, which the list of coverage hints doesn't name with its reason.`,
			]);
		}
	});

	test("fails on a listed hint that its file doesn't hold, and on a second copy of a hint", () => {
		const comment = hintComment(listed);
		expect(hintFailures(new Map([["a.ts", "const a = 1;\n"]]), [listed])).toStrictEqual([
			`The list of coverage hints names ${comment}, which a.ts doesn't hold.`,
		]);
		expect(hintFailures(new Map([["a.ts", `${comment}\n${comment}\n`]]), [listed])).toStrictEqual([
			`a.ts:2 holds the hint ${comment}, which the list of coverage hints doesn't name with its reason.`,
		]);
		expect(hintFailures(new Map([["a.ts", `${comment}\n`]]), [listed])).toStrictEqual([]);
	});
});
