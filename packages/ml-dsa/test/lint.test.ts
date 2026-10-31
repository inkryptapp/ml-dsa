import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";

import { lintFixturesEnvVar, lintFixturesFolder, lintFixturesOn } from "../../../lint-fixtures.js";
import { root, runScript, toolTimeout } from "./dev-tools.js";

const Label = z.object({ span: z.object({ line: z.number() }) });

const LintReport = z.object({
	diagnostics: z.array(
		z.object({
			code: z.string(),
			help: z.string().optional(),
			labels: z.tuple([Label], Label),
		}),
	),
});

type Diagnostic = z.infer<typeof LintReport>["diagnostics"][number];

function lintFixture(
	file: string,
	options: { readonly withFixtures: boolean },
): readonly Diagnostic[] {
	const path = `${lintFixturesFolder}/${file}`;
	const result = runScript("lint", ["--format", "json", "--no-error-on-unmatched-pattern", path], {
		// `spawnSync` drops a variable set to `undefined`, so a normal run also
		// clears a value inherited from the shell.
		[lintFixturesEnvVar]: options.withFixtures ? lintFixturesOn : undefined,
	});
	return LintReport.parse(JSON.parse(result.stdout)).diagnostics;
}

function sortedCodes(diagnostics: readonly Diagnostic[]): readonly string[] {
	return diagnostics.map((diagnostic) => diagnostic.code).toSorted();
}

describe("the project's lint command", { timeout: toolTimeout }, () => {
	test("reports each type-aware rule once", () => {
		expect(sortedCodes(lintFixture("type-aware.ts", { withFixtures: true }))).toStrictEqual([
			"typescript(no-base-to-string)",
			"typescript(restrict-plus-operands)",
			"typescript(restrict-template-expressions)",
		]);
	});

	test("reports every way to reach a member that detaches the buffer", () => {
		const file = "restricted-properties.ts";
		const expected = readFileSync(join(root, lintFixturesFolder, file), "utf8")
			.split("\n")
			.flatMap((text, index) => {
				const member = /\/\/ lint: (\w+)$/.exec(text)?.[1];
				if (member === undefined) {
					return [];
				}
				return [
					{
						code: "eslint(no-restricted-properties)",
						line: index + 1,
						help: `A ${member} call detaches the wasm memory's buffer.`,
					},
				];
			});
		const reported = lintFixture(file, { withFixtures: true })
			.map((diagnostic) => ({
				code: diagnostic.code,
				line: diagnostic.labels[0].span.line,
				help: diagnostic.help,
			}))
			.toSorted((left, right) => left.line - right.line);
		expect(expected).toHaveLength(6);
		expect(reported).toStrictEqual(expected);
	});

	test("skips the fixtures in a normal run", () => {
		expect(lintFixture("type-aware.ts", { withFixtures: false })).toStrictEqual([]);
	});
});
