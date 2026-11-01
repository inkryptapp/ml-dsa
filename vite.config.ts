import { readFile } from "node:fs/promises";

import { defineConfig } from "vite-plus";

import { lintFixturesEnvVar, lintFixturesFolder, lintFixturesOn } from "./lint-fixtures.js";

const vendoredSource = "vendor/mldsa-native";

// The vector files must stay byte-identical to their source repositories,
// so the formatter, which the pre-commit hook also runs, never rewrites them.
const vectorFolder = "vectors";

const ignoredLintFixtures =
	process.env[lintFixturesEnvVar] === lintFixturesOn ? [] : [lintFixturesFolder];

const bufferDetachingMembers = ["grow", "toResizableBuffer", "toFixedLengthBuffer"];

export default defineConfig({
	plugins: [
		{
			// The default entry imports the wasm module as base64 text. Without this
			// plugin, the test runner doesn't give a `.wasm` import that text.
			name: "ml-dsa:wasm-base64",
			enforce: "pre",
			async load(id) {
				if (!id.endsWith(".wasm")) {
					return null;
				}
				const base64 = (await readFile(id)).toString("base64");
				return `export default ${JSON.stringify(base64)};`;
			},
		},
	],
	lint: {
		ignorePatterns: [vendoredSource, ...ignoredLintFixtures],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		rules: {
			curly: ["error", "all"],
			eqeqeq: "error",
			"init-declarations": "error",
			"no-implicit-coercion": "error",
			"no-restricted-properties": [
				"error",
				...bufferDetachingMembers.map((property) => ({
					property,
					message: `A ${property} call detaches the wasm memory's buffer.`,
				})),
			],
			"typescript/ban-ts-comment": [
				"error",
				{
					"ts-expect-error": true,
					"ts-ignore": true,
					"ts-nocheck": true,
				},
			],
			"typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
			"typescript/no-base-to-string": "error",
			"typescript/no-explicit-any": "error",
			"typescript/no-non-null-assertion": "error",
			"typescript/restrict-plus-operands": "error",
			"typescript/restrict-template-expressions": "error",
			"unicorn/no-instanceof-builtins": ["error", { strategy: "strict" }],
		},
		overrides: [
			{
				// Apart from `as const`, only brand constructors may use `as`.
				files: ["packages/ml-dsa/src/brand.ts"],
				rules: {
					"typescript/consistent-type-assertions": "off",
				},
			},
		],
	},
	fmt: {
		useTabs: true,
		ignorePatterns: [vendoredSource, vectorFolder],
	},
	staged: {
		// Given paths, `vp check --fix` applies oxlint's safe fixes and oxfmt, and
		// reports lint and type errors only for those files.
		"*": "vp check --fix --no-error-on-unmatched-pattern",
	},
	test: {
		include: [
			"packages/*/test/**/*.test.ts",
			"packages/*/check/**/*.test.ts",
			"scripts/**/*.test.ts",
		],
		// The coverage gate, `pnpm run coverage`, runs the exit matrix alone. Its
		// rows must reach every statement, branch, and function in the file
		// that holds the core. Istanbul would insert calls into the core's
		// call-free cleanup blocks, so the gate uses V8's own coverage.
		coverage: {
			provider: "v8",
			include: ["packages/ml-dsa/src/core.ts"],
			reporter: ["text"],
			thresholds: { statements: 100, branches: 100, functions: 100 },
		},
	},
});
