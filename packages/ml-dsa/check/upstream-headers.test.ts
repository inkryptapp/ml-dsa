import { describe, expect, test } from "vite-plus/test";

import { CommandFailed } from "../../../scripts/check-step.ts";
import * as upstream from "../src/upstream.ts";
import {
	configDiffLines,
	failingLayoutLine,
	headerFailures,
	layoutConstants,
	layoutProbe,
	probeSections,
	prototypeLines,
	type HeaderFacts,
} from "./upstream-headers.ts";

const two = [
	{ name: "seedBytes", value: 32, expression: "MLDSA_SEEDBYTES" },
	{ name: "shakeStateAlignment", value: 8, expression: "_Alignof(mld_shake256ctx)" },
];

/** A short output of `build.sh probe` for two parameter sets, in the shape that the pinned clang prints. */
const output = `@@ prototypes 44
Printing mldsa44_keypair_internal:
int mldsa44_keypair_internal(uint8_t pk[1312], uint8_t sk[2560], const uint8_t seed[32])
Printing mldsa_shake256_init:
void mldsa_shake256_init(mld_shake256ctx *state)
@@ layout 44 passed
@@ config 44
#define MLD_CONFIG_H
#define MLD_CONFIG_FILE "mldsa_wasm_config.h"
#define MLD_CONFIG_NAMESPACE_PREFIX mldsa
#define MLD_CONFIG_PARAMETER_SET 44
#define MLD_NAMESPACE_PREFIX MLD_CONCAT(MLD_CONFIG_NAMESPACE_PREFIX, _)
@@ prototypes 65
Printing mldsa65_keypair_internal:
int mldsa65_keypair_internal(uint8_t pk[1952], uint8_t sk[4032], const uint8_t seed[32])
Printing mldsa_shake256_init:
void mldsa_shake256_init(mld_shake256ctx *state)
@@ layout 65 passed
@@ config 65
#define MLD_CONFIG_H
#define MLD_CONFIG_FILE "mldsa_wasm_config.h"
#define MLD_CONFIG_NAMESPACE_PREFIX mldsa
#define MLD_CONFIG_PARAMETER_SET 65
@@ config ct
#define MLD_CONFIG_H
#define MLD_CONFIG_KEYGEN_PCT 1
#define MLD_CONFIG_NAMESPACE_PREFIX MLD_DEFAULT_NAMESPACE_PREFIX
#define MLD_CONFIG_PARAMETER_SET 44
@@ failing-layout 44 failed
/tmp/tmp.x/failing-layout.c:3:16: error: static assertion failed due to requirement 'MLDSA_SEEDBYTES == 33'
1 error generated.
`;

const prototypes = `# ML-DSA-44
int mldsa44_keypair_internal(uint8_t pk[1312], uint8_t sk[2560], const uint8_t seed[32])
void mldsa_shake256_init(mld_shake256ctx *state)
# ML-DSA-65
int mldsa65_keypair_internal(uint8_t pk[1952], uint8_t sk[4032], const uint8_t seed[32])
void mldsa_shake256_init(mld_shake256ctx *state)
`;

const configDiff = `# ML-DSA-44 against upstream's CT config
+ #define MLD_CONFIG_FILE "mldsa_wasm_config.h"
- #define MLD_CONFIG_KEYGEN_PCT 1
- #define MLD_CONFIG_NAMESPACE_PREFIX MLD_DEFAULT_NAMESPACE_PREFIX
+ #define MLD_CONFIG_NAMESPACE_PREFIX mldsa
# ML-DSA-65 against upstream's CT config
+ #define MLD_CONFIG_FILE "mldsa_wasm_config.h"
- #define MLD_CONFIG_KEYGEN_PCT 1
- #define MLD_CONFIG_NAMESPACE_PREFIX MLD_DEFAULT_NAMESPACE_PREFIX
+ #define MLD_CONFIG_NAMESPACE_PREFIX mldsa
- #define MLD_CONFIG_PARAMETER_SET 44
+ #define MLD_CONFIG_PARAMETER_SET 65
`;

const healthy: HeaderFacts = {
	sections: probeSections(output),
	functionNames: ["mldsa44_keypair_internal", "mldsa65_keypair_internal", "mldsa_shake256_init"],
	committedPrototypes: prototypes,
	committedConfigDiff: configDiff,
};

/** `healthy` with the section `from` renamed to `to`, or dropped when `to` is `undefined`. */
function withSection(from: string, to: string | undefined, lines?: readonly string[]): HeaderFacts {
	const sections = new Map(healthy.sections);
	const kept = lines ?? sections.get(from) ?? [];
	sections.delete(from);
	if (to !== undefined) {
		sections.set(to, kept);
	}
	return { ...healthy, sections };
}

describe("layoutConstants", () => {
	test("covers every constant of src/upstream.ts, and the seed and randomness lengths", () => {
		expect(layoutConstants.map(({ name }) => name).toSorted()).toStrictEqual(
			[...Object.keys(upstream), "seedBytes", "randomnessBytes"].toSorted(),
		);
	});
});

describe("layoutProbe", () => {
	test("gives one _Static_assert per constant, with a message that names it", () => {
		expect(layoutProbe(two)).toBe(
			[
				'_Static_assert(MLDSA_SEEDBYTES == 32, "MLDSA_SEEDBYTES must equal seedBytes, which is 32");',
				'_Static_assert(_Alignof(mld_shake256ctx) == 8, "_Alignof(mld_shake256ctx) must equal shakeStateAlignment, which is 8");',
			].join("\n"),
		);
	});

	test("gives a failing line that expects the first constant plus one", () => {
		expect(failingLayoutLine(two)).toBe(
			'_Static_assert(MLDSA_SEEDBYTES == 33, "MLDSA_SEEDBYTES must equal seedBytes, which is 33");',
		);
		expect(() => failingLayoutLine([])).toThrow("The layout probe needs at least one constant.");
	});
});

describe("probeSections", () => {
	test("keys each section by its line and keeps its lines", () => {
		expect(probeSections("@@ a 1\nx\ny\n@@ b\n")).toStrictEqual(
			new Map([
				["a 1", ["x", "y"]],
				["b", [""]],
			]),
		);
	});

	test("rejects output before the first section and a repeated section", () => {
		expect(() => probeSections("x\n@@ a\n")).toThrow(
			new CommandFailed("The probe printed `x` before its first section."),
		);
		expect(() => probeSections("@@ a\n@@ a\n")).toThrow(
			new CommandFailed('The probe printed the section "a" twice.'),
		);
	});
});

describe("prototypeLines", () => {
	test("gives a heading per parameter set, then its declarations without clang's Printing lines", () => {
		expect(prototypeLines(healthy.sections)).toStrictEqual(prototypes.trimEnd().split("\n"));
	});
});

describe("configDiffLines", () => {
	test("lists, per parameter set, each MLD_CONFIG_ macro that differs from the CT config, by name", () => {
		expect(configDiffLines(healthy.sections)).toStrictEqual(configDiff.trimEnd().split("\n"));
	});
});

describe("headerFailures", () => {
	test("passes when the snapshots match, every layout passes, and the failing line fails", () => {
		expect(headerFailures(healthy)).toStrictEqual([]);
	});

	test("fails when upstream's headers lack a function that the module exports", () => {
		const functionNames = [...healthy.functionNames, "mldsa_shake256_reset"];
		expect(headerFailures({ ...healthy, functionNames })).toStrictEqual([
			"Upstream's headers declare no function mldsa_shake256_reset, which the module exports and the package calls.",
		]);
	});

	test("fails when a declaration differs from the committed snapshot", () => {
		const committedPrototypes = prototypes.replace("sk[2560]", "sk[2561]");
		expect(headerFailures({ ...healthy, committedPrototypes })).toStrictEqual([
			"packages/ml-dsa/check/prototypes.txt lacks the line `int mldsa44_keypair_internal(uint8_t pk[1312], uint8_t sk[2560], const uint8_t seed[32])`, which the pinned clang's dump of upstream's headers gives.",
			"packages/ml-dsa/check/prototypes.txt has the line `int mldsa44_keypair_internal(uint8_t pk[1312], uint8_t sk[2561], const uint8_t seed[32])`, which the pinned clang's dump of upstream's headers doesn't give.",
			"If the change is intended, review it, then make packages/ml-dsa/check/prototypes.txt hold exactly the lines that the pinned clang's dump of upstream's headers gives.",
		]);
	});

	test("fails with clang's messages when the layout probe fails for a parameter set", () => {
		const messages = ["layout.c:3:16: error: static assertion failed", "1 error generated."];
		expect(
			headerFailures(withSection("layout 65 passed", "layout 65 failed", messages)),
		).toStrictEqual([
			`The layout probe failed for ML-DSA-65, so a constant of the package differs from upstream's headers. clang reports:\n${messages.join("\n")}`,
		]);
		expect(headerFailures(withSection("layout 44 passed", undefined))).toStrictEqual([
			"The probe printed no layout result for ML-DSA-44.",
		]);
	});

	test("fails when the failing line passes, or fails for another reason", () => {
		const message =
			"The failing layout line didn't fail with a static assertion, so the layout probe may not evaluate its assertions.";
		expect(
			headerFailures(withSection("failing-layout 44 failed", "failing-layout 44 passed")),
		).toStrictEqual([message]);
		expect(
			headerFailures(
				withSection("failing-layout 44 failed", "failing-layout 44 failed", [
					"failing-layout.c:1:10: fatal error: 'src/sign.h' file not found",
				]),
			),
		).toStrictEqual([message]);
	});

	test("fails when a shipped macro differs from the committed config diff", () => {
		const sections = new Map(healthy.sections);
		sections.set("config 65", [
			...(sections.get("config 65") ?? []),
			"#define MLD_CONFIG_KEYGEN_PCT 1",
		]);
		expect(headerFailures({ ...healthy, sections })).toStrictEqual([
			"packages/ml-dsa/check/config-diff.txt has the line `- #define MLD_CONFIG_KEYGEN_PCT 1`, which the diff of the shipped config against upstream's CT config doesn't give.",
			"If the change is intended, review it, then make packages/ml-dsa/check/config-diff.txt hold exactly the lines that the diff of the shipped config against upstream's CT config gives.",
		]);
	});

	test("fails with one message when the probe printed no CT config or no parameter set", () => {
		expect(headerFailures(withSection("config ct", undefined))).toStrictEqual([
			"The probe printed no macros for upstream's CT config.",
		]);
		expect(headerFailures({ ...healthy, sections: new Map() })).toStrictEqual([
			"The probe printed no prototypes section, so it compiled no parameter set.",
		]);
	});
});
