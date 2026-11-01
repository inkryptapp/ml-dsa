import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "./check-step.ts";
import {
	clangMajor,
	ctActionPath,
	ctDefinitions,
	CtMatrixError,
	ctWorkflowPath,
	newestClangLevels,
	newestClangMajor,
	readCtActionDefinitions,
	readCtMatrix,
	type CtMatrix,
} from "./ct-matrix.ts";

/** A workflow with one job, whose matrix lists `shells` and whose CT steps are `steps`. */
function workflow(shells: string, steps: string): string {
	return `name: CT
jobs:
  ct:
    strategy:
      matrix:
        nix-shell:
${shells}
    steps:
      - uses: actions/checkout@v7
${steps}
`;
}

/** A CT step with `cflags`, and the `if` line `condition` when it has one. */
function step(cflags: string, condition?: string): string {
	return [
		`      - name: Build and run test (${cflags})`,
		...(condition === undefined ? [] : [`        if: ${condition}`]),
		"        uses: ./.github/actions/ct-test",
		"        with:",
		`          cflags: ${cflags} -DMLD_CONFIG_KEYGEN_PCT`,
	].join("\n");
}

/** The tested levels of each entry, in the order that the steps test them. */
function levels(matrix: CtMatrix): Record<string, readonly string[]> {
	return Object.fromEntries(
		[...matrix].map(([nixShell, tested]) => [nixShell, [...tested.keys()]]),
	);
}

describe("readCtMatrix", () => {
	test("reads the CT matrix of the pin, where the step conditions keep -Ofast from clang 20 to 22", () => {
		const text = readFileSync(join(root, "vendor/mldsa-native", ctWorkflowPath), "utf8");
		const all = ["-Oz", "-Os", "-O3", "-Ofast", "-O2", "-O1", "-O0"];
		const noOfast = ["-Oz", "-Os", "-O3", "-O2", "-O1", "-O0"];
		expect(levels(readCtMatrix(text))).toStrictEqual({
			"valgrind-varlat_clang6": all,
			"valgrind-varlat_clang20": noOfast,
			"valgrind-varlat_clang21": noOfast,
			"valgrind-varlat_clang22": noOfast,
			"valgrind-varlat_gcc48": ["-Os", "-O3", "-Ofast", "-O2", "-O1", "-O0"],
			"valgrind-varlat_gcc14": all,
			"valgrind-varlat_gcc15": all,
			"valgrind-varlat_gcc16": all,
		});
	});

	test("keeps the -D definitions of the step that tests each level", () => {
		const text = readFileSync(join(root, "vendor/mldsa-native", ctWorkflowPath), "utf8");
		expect(readCtMatrix(text).get("valgrind-varlat_clang22")?.get("-O3")).toStrictEqual([
			["-DMLD_CONFIG_KEYGEN_PCT"],
		]);
	});

	test("keeps each distinct definition set of the steps that test one level, once", () => {
		const text = workflow(
			"          - a",
			[step("-O3"), step("-O3 -DNTESTS=5"), step("-O3")].join("\n"),
		);
		expect(readCtMatrix(text).get("a")?.get("-O3")).toStrictEqual([
			["-DMLD_CONFIG_KEYGEN_PCT"],
			["-DNTESTS=5", "-DMLD_CONFIG_KEYGEN_PCT"],
		]);
	});

	test("counts only the nix-shell list, not a compiler that a comment or a condition names", () => {
		const text = workflow(
			"          - valgrind-varlat_clang22\n          # - valgrind-varlat_clang23",
			step("-O3", "${{ matrix.nix-shell != 'valgrind-varlat_clang24' }}"),
		);
		const matrix = readCtMatrix(text);
		expect(levels(matrix)).toStrictEqual({ "valgrind-varlat_clang22": ["-O3"] });
		expect(newestClangMajor(matrix)).toBe(22);
	});

	test("reads a flow-style list", () => {
		const text = workflow(
			"          [valgrind-varlat_clang21, valgrind-varlat_clang22]",
			step("-O2"),
		);
		expect(newestClangMajor(readCtMatrix(text))).toBe(22);
	});

	test("evaluates ==, !=, &&, ||, and parentheses, without regard to case", () => {
		const text = workflow(
			"          - a\n          - b\n          - c",
			[
				step("-O0", "${{ matrix.nix-shell == 'A' }}"),
				step("-O1", "matrix.nix-shell != 'a' && matrix.nix-shell != 'b'"),
				step(
					"-O2",
					"${{ matrix.nix-shell == 'a' || matrix.nix-shell == 'c' && matrix.nix-shell == 'b' }}",
				),
				step(
					"-O3",
					"${{ (matrix.nix-shell == 'a' || matrix.nix-shell == 'c') && matrix.nix-shell != 'a' }}",
				),
				step("-Os", "${{ 'b' == matrix.nix-shell }}"),
				step("-Oz", "false"),
				step("-Ofast", "true"),
			].join("\n"),
		);
		expect(levels(readCtMatrix(text))).toStrictEqual({
			a: ["-O0", "-O2", "-Ofast"],
			b: ["-Os", "-Ofast"],
			c: ["-O1", "-O3", "-Ofast"],
		});
	});

	test("credits a step's -O level only when its other flags are -D definitions", () => {
		const text = workflow(
			"          - a",
			[step("-O3 -O0"), step("-O2 -ffast-math"), step("-O1 -DNTESTS=5"), step("-Os")].join("\n"),
		);
		expect(levels(readCtMatrix(text))).toStrictEqual({ a: ["-O1", "-Os"] });
	});

	test("skips a job whose condition is false, and rejects any other job condition", () => {
		const disabled = workflow("          - valgrind-varlat_clang23", step("-O3")).replace(
			"  ct:\n",
			"  ct:\n    if: false\n",
		);
		const enabled = workflow("          - valgrind-varlat_clang22", step("-O2")).replace(
			"jobs:\n",
			"jobs:\n  enabled:\n    if: true\n    strategy:\n      matrix:\n        nix-shell: [valgrind-varlat_clang21]\n    steps:\n" +
				step("-O1") +
				"\n",
		);
		expect(() => readCtMatrix(disabled)).toThrow(
			".github/workflows/ct-tests.yml has no enabled job with a nix-shell matrix list.",
		);
		expect(levels(readCtMatrix(enabled))).toStrictEqual({
			"valgrind-varlat_clang21": ["-O1"],
			"valgrind-varlat_clang22": ["-O2"],
		});
		const conditional = workflow("          - a", step("-O3")).replace(
			"  ct:\n",
			"  ct:\n    if: ${{ github.event_name == 'push' }}\n",
		);
		expect(() => readCtMatrix(conditional)).toThrow(
			"The job \"ct\" has the condition `${{ github.event_name == 'push' }}`, which the check can't evaluate.",
		);
	});

	test("reads -O levels only from steps that run the CT test action", () => {
		const text = workflow(
			"          - valgrind-varlat_clang22",
			"      - uses: ./.github/actions/other\n        with:\n          cflags: -O1",
		);
		expect(levels(readCtMatrix(text))).toStrictEqual({ "valgrind-varlat_clang22": [] });
	});

	test("rejects a condition that it can't evaluate", () => {
		for (const condition of [
			"${{ matrix.system == 'ubuntu-latest' }}",
			"${{ contains(matrix.nix-shell, 'clang') }}",
			"${{ !(matrix.nix-shell == 'a') }}",
			"${{ matrix.nix-shell == 'a' && }}",
			"${{ (matrix.nix-shell == 'a' }}",
		]) {
			expect(
				() => readCtMatrix(workflow("          - a", step("-O3", condition))),
				condition,
			).toThrow(CtMatrixError);
		}
	});

	test("rejects a matrix with include or exclude entries", () => {
		const text = workflow(
			"          - a\n        include:\n          - nix-shell: valgrind-varlat_clang23",
			step("-O3"),
		);
		expect(() => readCtMatrix(text)).toThrow(
			'The matrix of the job "ct" has include or exclude entries, which the check can\'t follow.',
		);
	});

	test("rejects a nix-shell entry that isn't a list of names", () => {
		expect(() => readCtMatrix(workflow("          [1, 2]", step("-O3")))).toThrow(
			'The nix-shell matrix of the job "ct" isn\'t a list of names.',
		);
		const text =
			"jobs:\n  ct:\n    strategy:\n      matrix:\n        nix-shell: ${{ fromJSON(inputs.shells) }}\n";
		expect(() => readCtMatrix(text)).toThrow(CtMatrixError);
	});

	test("rejects a workflow with no nix-shell list, or no jobs", () => {
		expect(() => readCtMatrix("jobs:\n  build:\n    runs-on: ubuntu-latest\n")).toThrow(
			".github/workflows/ct-tests.yml has no enabled job with a nix-shell matrix list.",
		);
		expect(() => readCtMatrix("name: CT\n")).toThrow(CtMatrixError);
	});
});

describe("clangMajor", () => {
	test("reads the major from a clang entry, and nothing from another compiler", () => {
		expect(clangMajor("valgrind-varlat_clang22")).toBe(22);
		expect(clangMajor("clang6")).toBe(6);
		expect(clangMajor("valgrind-varlat_gcc14")).toBeUndefined();
		expect(clangMajor("valgrind-varlat_clang22-asan")).toBeUndefined();
	});
});

const sample: CtMatrix = new Map([
	["valgrind-varlat_clang21", new Map([["-O3", [["-DOLD"]]]])],
	[
		"valgrind-varlat_clang22",
		new Map([
			["-O3", [["-DMLD_CONFIG_KEYGEN_PCT"]]],
			["-O2", [[]]],
		]),
	],
	["clang22", new Map([["-O3", [["-DMLD_CONFIG_KEYGEN_PCT"]]]])],
	["valgrind-varlat_gcc16", new Map([["-O3", [["-DGCC"]]]])],
]);

describe("newestClangLevels", () => {
	test("merges the levels of the newest clang's entries, each definition set once", () => {
		expect(newestClangLevels(sample)).toStrictEqual(
			new Map([
				["-O3", [["-DMLD_CONFIG_KEYGEN_PCT"]]],
				["-O2", [[]]],
			]),
		);
		expect(newestClangLevels(new Map([["gcc14", new Map([["-O3", [[]]]])]]))).toStrictEqual(
			new Map(),
		);
	});
});

describe("ctDefinitions", () => {
	test("gives the action's definitions, then those of the newest clang's step for the level", () => {
		expect(ctDefinitions(sample, ["-DMLD_CONFIG_CT_TESTING_ENABLED"], "-O3")).toStrictEqual([
			"-DMLD_CONFIG_CT_TESTING_ENABLED",
			"-DMLD_CONFIG_KEYGEN_PCT",
		]);
		expect(ctDefinitions(sample, ["-DA"], "-O2")).toStrictEqual(["-DA"]);
	});

	test("rejects a level that the newest clang doesn't test, or tests with two sets of definitions", () => {
		expect(() => ctDefinitions(sample, [], "-Os")).toThrow(
			new CtMatrixError(
				"The CT steps of the newest clang must test -Os with one set of definitions, but they give none.",
			),
		);
		const split = new Map([...sample, ["asan_clang22", new Map([["-O3", [["-DOTHER"]]]])]]);
		expect(() => ctDefinitions(split, [], "-O3")).toThrow(
			new CtMatrixError(
				'The CT steps of the newest clang must test -O3 with one set of definitions, but they give "-DMLD_CONFIG_KEYGEN_PCT" and "-DOTHER".',
			),
		);
	});
});

describe("newestClangMajor", () => {
	test("compares the majors as numbers, and gives undefined without a clang", () => {
		expect(
			newestClangMajor(
				new Map([
					["clang9", new Map()],
					["clang10", new Map()],
				]),
			),
		).toBe(10);
		expect(newestClangMajor(new Map([["gcc14", new Map()]]))).toBeUndefined();
	});
});

/** A composite action whose one run step runs `command`. */
function action(command: string): string {
	return `name: CT Test
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        # --cflags="-DIN_A_COMMENT \${{ inputs.cflags }}"
        ${command}
`;
}

describe("readCtActionDefinitions", () => {
	test("reads the definitions that the CT action at the pin adds to every step", () => {
		const text = readFileSync(join(root, "vendor/mldsa-native", ctActionPath), "utf8");
		expect(readCtActionDefinitions(text)).toStrictEqual([
			"-DMLD_CONFIG_CT_TESTING_ENABLED",
			"-DNTESTS=5",
		]);
	});

	test("skips comment lines", () => {
		expect(
			readCtActionDefinitions(action('tests func --cflags="-DA=1 ${{ inputs.cflags }} -DB"')),
		).toStrictEqual(["-DA=1", "-DB"]);
	});

	test("rejects no --cflags value, two values, a value without the step's cflags, and other flags", () => {
		const message = `${ctActionPath} must pass exactly one --cflags value that holds \${{ inputs.cflags }}.`;
		expect(() => readCtActionDefinitions(action("tests func"))).toThrow(message);
		expect(() =>
			readCtActionDefinitions(
				action('tests func --cflags="${{ inputs.cflags }}" --cflags="${{ inputs.cflags }}"'),
			),
		).toThrow(message);
		expect(() => readCtActionDefinitions(action('tests func --cflags="-DA"'))).toThrow(message);
		expect(() =>
			readCtActionDefinitions(action('tests func --cflags="-DA -O0 ${{ inputs.cflags }}"')),
		).toThrow(
			`The --cflags value of ${ctActionPath} adds "-DA -O0", but the check follows only -D definitions there.`,
		);
		expect(() => readCtActionDefinitions("name: CT Test\n")).toThrow(CtMatrixError);
	});
});
