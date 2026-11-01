import { describe, expect, test } from "vite-plus/test";

import {
	featureProbeArguments,
	featureProbeFailures,
	targetFeatureFailures,
	type FeatureRow,
} from "./target-features.ts";
import { probeSections } from "./upstream-headers.ts";
import { readModule } from "./wasm-binary.ts";
import { customSection, name, vector, wasmModule } from "./wasm-fixtures.ts";

/** A `target_features` section with each entry's prefix and name. */
function targetFeatures(...entries: readonly string[]): number[] {
	return customSection(
		"target_features",
		vector(entries.map((entry) => [entry.charCodeAt(0), ...name(entry.slice(1))])),
	);
}

const moduleFile = "packages/ml-dsa/wasm/mldsa.wasm";

describe("targetFeatureFailures", () => {
	test("passes when the one entry is +bulk-memory-opt", () => {
		expect(
			targetFeatureFailures(readModule(wasmModule(targetFeatures("+bulk-memory-opt")))),
		).toStrictEqual([]);
	});

	test("fails on another entry, a missing entry, a missing section, and a second section", () => {
		expect(
			targetFeatureFailures(
				readModule(wasmModule(targetFeatures("+bulk-memory-opt", "+sign-ext"))),
			),
		).toStrictEqual([
			`The target_features section of ${moduleFile} lists +bulk-memory-opt, +sign-ext, but it must list exactly +bulk-memory-opt.`,
		]);
		expect(
			targetFeatureFailures(readModule(wasmModule(targetFeatures("=bulk-memory-opt")))),
		).toStrictEqual([
			`The target_features section of ${moduleFile} lists =bulk-memory-opt, but it must list exactly +bulk-memory-opt.`,
		]);
		expect(targetFeatureFailures(readModule(wasmModule()))).toStrictEqual([
			`${moduleFile} has no target_features section, so the check can't read which features the compiler used.`,
		]);
		const section = targetFeatures("+bulk-memory-opt");
		expect(targetFeatureFailures(readModule(wasmModule(section, section)))).toStrictEqual([
			`${moduleFile} has 2 target_features sections, but it must have one.`,
		]);
	});
});

const known: FeatureRow = { clang: "sign-ext", wasmTools: "sign-extension", prerequisites: [] };
const withPrerequisite: FeatureRow = {
	clang: "relaxed-simd",
	wasmTools: "relaxed-simd",
	prerequisites: ["simd"],
};
const unknown: FeatureRow = {
	clang: "fp16",
	wasmTools: undefined,
	prerequisites: ["simd"],
	rejection: { offset: 0x3e, message: "unknown 0xfd subopcode: 0x120" },
	witness: { features: ["simd128", "fp16"], instruction: "f16x8.splat", export: "splat" },
};
const table = [known, withPrerequisite, unknown];

describe("featureProbeArguments", () => {
	test("validates the module, the positive fixture, each fixture twice, and the unknown feature's runs", () => {
		expect(featureProbeArguments(table)).toStrictEqual([
			`${moduleFile}=mvp,bulk-memory-opt`,
			"bulk-memory-opt=mvp,bulk-memory-opt",
			"bulk-memory-opt=mvp",
			"sign-ext=mvp,bulk-memory-opt",
			"sign-ext=mvp,bulk-memory-opt,sign-extension",
			"relaxed-simd=mvp,bulk-memory-opt,simd",
			"relaxed-simd=mvp,bulk-memory-opt,simd,relaxed-simd",
			"fp16=mvp,bulk-memory-opt",
			"fp16=mvp,bulk-memory-opt,simd",
			"fp16=all",
			"fp16=mvp,fp16",
			"witness:fp16:splat=simd128,fp16",
		]);
	});
});

/** The output of the probe for {@link table}, with each section's text, which `changes` can replace. */
function probeOutput(changes: Readonly<Record<string, string>> = {}): string {
	const fixtureBase64 = Buffer.from([0x00, 0x61, 0x73, 0x6d]).toString("base64");
	const defaults: Readonly<Record<string, string>> = {
		llc: [
			"Available CPUs for this target:",
			"",
			"  mvp           - Select the mvp processor.",
			"",
			"Available features for this target:",
			"",
			"  bulk-memory-opt - Enable bulk memory optimization operations.",
			"  fp16          - Enable FP16 instructions.",
			"  relaxed-simd  - Enable relaxed-simd instructions.",
			"  sign-ext      - Enable sign extension operators.",
			"",
			"Use +feature to enable a feature, or -feature to disable it.",
		].join("\n"),
		[`validate ${moduleFile} mvp,bulk-memory-opt`]: "passed",
		"validate bulk-memory-opt mvp,bulk-memory-opt": "passed",
		"validate bulk-memory-opt mvp": "failed\nerror: bulk memory support is not enabled",
		"validate sign-ext mvp,bulk-memory-opt": "failed\nerror: func 0 failed to validate",
		"validate sign-ext mvp,bulk-memory-opt,sign-extension": "passed",
		"validate relaxed-simd mvp,bulk-memory-opt,simd":
			"failed\nerror: relaxed SIMD support is not enabled",
		"validate relaxed-simd mvp,bulk-memory-opt,simd,relaxed-simd": "passed",
		"validate fp16 mvp,bulk-memory-opt":
			"failed\nerror: SIMD support is not enabled (at offset 0xb)",
		"validate fp16 mvp,bulk-memory-opt,simd":
			"failed\nerror: func 0 failed to validate\n\nCaused by:\n    0: unknown 0xfd subopcode: 0x120 (at offset 0x3e)",
		"validate fp16 all":
			"failed\nerror: func 0 failed to validate\n\nCaused by:\n    0: unknown 0xfd subopcode: 0x120 (at offset 0x3e)",
		"validate fp16 mvp,fp16":
			"failed\nerror: invalid value 'mvp,fp16' for '--features <FEATURES>': unknown feature `fp16`",
		"witness fp16 assembly": "splat:\n\tlocal.get\t0\n\tf16x8.splat\n\tend_function",
		"witness fp16 module": fixtureBase64,
		"fixture fp16": fixtureBase64,
	};
	return Object.entries({ ...defaults, ...changes })
		.map(([section, body]) => {
			const [status, ...rest] = body.split("\n");
			return section.startsWith("validate ")
				? [`@@ ${section} ${status ?? ""}`, ...rest].join("\n")
				: `@@ ${section}\n${body}`;
		})
		.join("\n");
}

/** The fixture's file name: a `.wasm` for the unknown feature, which wasm-tools can't decode. */
function fixtureName(row: FeatureRow): string {
	return row.wasmTools === undefined ? `${row.clang}.wasm` : `${row.clang}.wat`;
}

function failures(changes: Readonly<Record<string, string>> = {}, rows = table): readonly string[] {
	return featureProbeFailures({
		sections: probeSections(probeOutput(changes)),
		table: rows,
		fixtures: [...rows.map((row) => fixtureName(row)), "bulk-memory-opt.wat"],
	});
}

describe("featureProbeFailures", () => {
	test("passes when every run gives the result that its rule expects", () => {
		expect(failures()).toStrictEqual([]);
	});

	test("fails when the validator rejects the module or the positive fixture", () => {
		expect(
			failures({
				[`validate ${moduleFile} mvp,bulk-memory-opt`]:
					"failed\nerror: SIMD support is not enabled",
				"validate bulk-memory-opt mvp,bulk-memory-opt": "failed\nerror: bad",
				"validate bulk-memory-opt mvp": "passed",
			}),
		).toStrictEqual([
			`\`wasm-tools validate --features=mvp,bulk-memory-opt\` rejects ${moduleFile}:\nerror: SIMD support is not enabled`,
			"`wasm-tools validate --features=mvp,bulk-memory-opt` rejects packages/ml-dsa/check/features/bulk-memory-opt.wat, the fixture that must pass with the allowlist alone:\nerror: bad",
			"`wasm-tools validate --features=mvp` accepts packages/ml-dsa/check/features/bulk-memory-opt.wat, so the fixture doesn't use bulk-memory-opt.",
		]);
	});

	test("fails when a fixture passes without its feature or fails with it", () => {
		expect(
			failures({
				"validate sign-ext mvp,bulk-memory-opt": "passed",
				"validate relaxed-simd mvp,bulk-memory-opt,simd,relaxed-simd":
					"failed\nerror: SIMD support is not enabled",
			}),
		).toStrictEqual([
			"`wasm-tools validate --features=mvp,bulk-memory-opt` accepts packages/ml-dsa/check/features/sign-ext.wat, so the fixture doesn't prove that the allowlist rejects sign-ext.",
			"`wasm-tools validate --features=mvp,bulk-memory-opt,simd,relaxed-simd` rejects packages/ml-dsa/check/features/relaxed-simd.wat, so the fixture tests something other than relaxed-simd:\nerror: SIMD support is not enabled",
		]);
	});

	test("fails on a feature that the table lacks, a row that clang doesn't list, and a fixture without a row", () => {
		const llc = [
			"Available features for this target:",
			"  bulk-memory-opt - Enable bulk memory optimization operations.",
			"  fp16          - Enable FP16 instructions.",
			"  sign-ext      - Enable sign extension operators.",
			"  tail-call     - Enable tail call instructions.",
		].join("\n");
		expect(
			featureProbeFailures({
				sections: probeSections(probeOutput({ llc })),
				table,
				fixtures: [
					"bulk-memory-opt.wat",
					"fp16.wasm",
					"relaxed-simd.wat",
					"sign-ext.wat",
					"simd128.wat",
				],
			}),
		).toStrictEqual([
			"The pinned llc lists the wasm feature tail-call, but packages/ml-dsa/check/target-features.ts has no row for it, so no fixture proves that the allowlist rejects it.",
			"packages/ml-dsa/check/target-features.ts has a row for relaxed-simd, which the pinned llc doesn't list.",
			"packages/ml-dsa/check/features/simd128.wat has no row in packages/ml-dsa/check/target-features.ts.",
		]);
	});

	test("fails when llc lists no features", () => {
		expect(
			failures({ llc: "Available CPUs for this target:\n  mvp - Select the mvp processor." }),
		).toStrictEqual(["The pinned `llc -mtriple=wasm32 -mattr=help` lists no wasm features."]);
	});

	test("fails when a row's fixture is missing", () => {
		expect(
			featureProbeFailures({
				sections: probeSections(probeOutput()),
				table,
				fixtures: ["bulk-memory-opt.wat", "sign-ext.wat"],
			}),
		).toStrictEqual([
			"The fixture packages/ml-dsa/check/features/relaxed-simd.wat is missing.",
			"The fixture packages/ml-dsa/check/features/fp16.wasm is missing.",
		]);
	});

	test("fails when wasm-tools knows a feature that the table calls unknown", () => {
		expect(
			failures({
				"validate fp16 mvp,fp16": "failed\nerror: func 0 failed to validate",
				"validate fp16 all": "passed",
			}),
		).toStrictEqual([
			"`wasm-tools validate --features=all` accepts packages/ml-dsa/check/features/fp16.wasm, so wasm-tools knows a feature that enables fp16. Give the row its wasm-tools name.",
			"wasm-tools knows the feature name fp16, so the row's exception lapses. Give the row its wasm-tools name.",
		]);
	});

	test("fails when an unknown feature's fixture fails elsewhere than at the recorded offset", () => {
		expect(
			failures({
				"validate fp16 mvp,bulk-memory-opt": "passed",
				"validate fp16 mvp,bulk-memory-opt,simd":
					"failed\nerror: func 0 failed to validate\n\nCaused by:\n    0: unknown 0xfd subopcode: 0x120 (at offset 0x3f)",
			}),
		).toStrictEqual([
			"`wasm-tools validate --features=mvp,bulk-memory-opt` accepts packages/ml-dsa/check/features/fp16.wasm, so the fixture doesn't prove that the allowlist rejects fp16.",
			"`wasm-tools validate --features=mvp,bulk-memory-opt,simd` must reject packages/ml-dsa/check/features/fp16.wasm with `unknown 0xfd subopcode: 0x120 (at offset 0x3e)`, but it reports:\nerror: func 0 failed to validate\n\nCaused by:\n    0: unknown 0xfd subopcode: 0x120 (at offset 0x3f)",
		]);
	});

	test("fails when clang's assembly doesn't name the instruction or doesn't reproduce the fixture", () => {
		expect(
			failures({
				"witness fp16 assembly": "splat:\n\tlocal.get\t0\n\tend_function",
				"witness fp16 module": Buffer.from([0x00]).toString("base64"),
			}),
		).toStrictEqual([
			"clang's assembly for packages/ml-dsa/check/features/fp16.c doesn't name f16x8.splat.",
			"Assembling clang's assembly for packages/ml-dsa/check/features/fp16.c gives other bytes than packages/ml-dsa/check/features/fp16.wasm.",
		]);
	});

	test("fails when the probe skipped a run", () => {
		const output = probeOutput().replace(/@@ validate fp16 all failed\n[^@]*/, "");
		expect(
			featureProbeFailures({
				sections: probeSections(output),
				table,
				fixtures: ["bulk-memory-opt.wat", ...table.map(fixtureName)],
			}),
		).toStrictEqual([
			"The probe printed no result for `wasm-tools validate --features=all` on fp16.",
		]);
	});
});
