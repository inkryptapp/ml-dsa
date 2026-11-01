import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { ctWorkflowPath, readCtMatrix } from "../../../scripts/ct-matrix.ts";
import { optimizationLevels, toolchainFailures, type ToolchainFacts } from "./toolchain.ts";
import { producerSections, readModule, type ProducerFields } from "./wasm-binary.ts";

/** The facts of the committed module, the CT matrix at the pin, and the committed build script. */
const committed: ToolchainFacts = {
	producerSections: producerSections(
		readModule(readFileSync(join(root, "packages/ml-dsa/wasm/mldsa.wasm"))),
	),
	matrix: readCtMatrix(readFileSync(join(root, "vendor/mldsa-native", ctWorkflowPath), "utf8")),
	optimizationLevels: optimizationLevels(
		readFileSync(join(root, "packages/ml-dsa/wasm/build.sh"), "utf8"),
	),
	pinnedClang: "22.1.5",
};

function builtWith(...tools: readonly (readonly [string, string])[]): ProducerFields {
	return new Map([["processed-by", tools.map(([name, version]) => ({ name, version }))]]);
}

const workflow = "the CT matrix in vendor/mldsa-native/.github/workflows/ct-tests.yml";

describe("toolchainFailures", () => {
	test("passes the committed module, the CT matrix at the pin, and the build script", () => {
		expect(committed.producerSections).toStrictEqual([builtWith(["clang", "22.1.5"])]);
		expect(committed.optimizationLevels).toStrictEqual(["-O3"]);
		expect(toolchainFailures(committed)).toStrictEqual([]);
	});

	test("fails when the module has no producers section, or more than one", () => {
		expect(toolchainFailures({ ...committed, producerSections: [] })).toStrictEqual([
			"packages/ml-dsa/wasm/mldsa.wasm has no producers section, so the check can't read which clang built it.",
		]);
		const section = builtWith(["clang", "22.1.5"]);
		expect(toolchainFailures({ ...committed, producerSections: [section, section] })).toStrictEqual(
			["packages/ml-dsa/wasm/mldsa.wasm has 2 producers sections, but it must have one."],
		);
	});

	test("fails when processed-by lists another tool, another clang, or nothing", () => {
		for (const [producers, listed] of [
			[builtWith(["clang", "22.1.5"], ["wasm-opt", "124"]), "clang 22.1.5, wasm-opt 124"],
			[builtWith(["clang", "22.1.4"]), "clang 22.1.4"],
			[builtWith(["gcc", "22.1.5"]), "gcc 22.1.5"],
			[new Map(), ""],
		] as const) {
			expect(toolchainFailures({ ...committed, producerSections: [producers] })).toStrictEqual([
				`The producers section of packages/ml-dsa/wasm/mldsa.wasm lists "${listed}" as processed-by, but it must list only the pinned clang 22.1.5.`,
			]);
		}
	});

	test("fails when the module's clang major isn't the newest in the CT matrix", () => {
		const matrix = new Map([
			...committed.matrix,
			["valgrind-varlat_clang23", new Map([["-O3", [[]]]])],
		]);
		expect(toolchainFailures({ ...committed, matrix })).toStrictEqual([
			`packages/ml-dsa/wasm/mldsa.wasm was built with clang 22, but the newest clang in ${workflow} is clang 23. A pin bump moves the toolchain to the newest clang major in the CT matrix.`,
		]);
		expect(
			toolchainFailures({
				...committed,
				producerSections: [builtWith(["clang", "21.1.8"])],
				pinnedClang: "21.1.8",
			}),
		).toStrictEqual([
			`packages/ml-dsa/wasm/mldsa.wasm was built with clang 21, but the newest clang in ${workflow} is clang 22. A pin bump moves the toolchain to the newest clang major in the CT matrix.`,
		]);
	});

	test("fails when the CT matrix names no clang", () => {
		const matrix = new Map([["valgrind-varlat_gcc16", new Map([["-O3", [[]]]])]]);
		expect(toolchainFailures({ ...committed, matrix })).toStrictEqual([
			`${workflow} names no clang.`,
		]);
	});

	test("fails when the CT matrix doesn't test the build's -O level for the newest clang", () => {
		expect(toolchainFailures({ ...committed, optimizationLevels: ["-Ofast"] })).toStrictEqual([
			`packages/ml-dsa/wasm/build.sh passes -Ofast, but ${workflow} tests clang 22 only at -Oz -Os -O3 -O2 -O1 -O0.`,
		]);
	});

	test("fails unless the build script passes exactly one -O flag", () => {
		expect(toolchainFailures({ ...committed, optimizationLevels: [] })).toStrictEqual([
			"packages/ml-dsa/wasm/build.sh must pass exactly one -O flag, but it passes none.",
		]);
		expect(toolchainFailures({ ...committed, optimizationLevels: ["-O3", "-O2"] })).toStrictEqual([
			"packages/ml-dsa/wasm/build.sh must pass exactly one -O flag, but it passes -O3 -O2.",
		]);
	});
});

describe("optimizationLevels", () => {
	test("reads each -O word without its quotes, and skips comments", () => {
		const script = [
			"# -O2 in a comment",
			'cflags=(-O3 "-Os" --target=wasm32) # -O1 after code',
			"echo '#' -Oz; level=-Ofast",
			"-Wall -O",
		].join("\n");
		expect(optimizationLevels(script)).toStrictEqual(["-O3", "-Os", "-Oz", "-Ofast", "-O"]);
	});
});
