import { defineConfig } from "vite-plus";

import { lintFixturesEnvVar, lintFixturesFolder, lintFixturesOn } from "./lint-fixtures.js";

const vendoredSource = "vendor/mldsa-native";

const ignoredLintFixtures =
	process.env[lintFixturesEnvVar] === lintFixturesOn ? [] : [lintFixturesFolder];

const bufferDetachingMembers = ["grow", "toResizableBuffer", "toFixedLengthBuffer"];

export default defineConfig({
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
		ignorePatterns: [vendoredSource],
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
	},
});
