/**
 * The checks of upstream's C headers, which the pinned clang probes through
 * `build.sh probe` with the shipped flags:
 *
 * - The C-prototype snapshot. Each function that the module exports must be
 *   declared in upstream's headers, and the declarations must equal the
 *   committed `prototypes.txt`.
 * - The layout probe. One `_Static_assert` per constant in
 *   {@link layoutConstants} must compile once per parameter set, and a
 *   failing line must not, which proves that the compile evaluates them.
 * - The config diff. The `MLD_CONFIG_*` macros under the shipped config of
 *   each parameter set, against those under upstream's CT config, must equal
 *   the committed `config-diff.txt`. Record 0002 in docs/adr/ explains each
 *   difference.
 */
import { CommandFailed } from "../../../scripts/check-step.ts";
import { randomnessBytes, seedBytes } from "../src/parameter-sets.ts";
import * as upstream from "../src/upstream.ts";
import { snapshotFailures } from "./snapshot.ts";

/** The committed C-prototype snapshot, relative to the repo root. */
export const prototypesFile = "packages/ml-dsa/check/prototypes.txt";

/** The committed config diff, relative to the repo root. */
export const configDiffFile = "packages/ml-dsa/check/config-diff.txt";

/** A constant of the package, with the C expression in upstream's headers that it must equal. */
export interface LayoutConstant {
	/** The constant's name in the package source. */
	readonly name: string;
	readonly value: number;
	readonly expression: string;
}

/**
 * The constants that size the package's regions or that the package passes
 * to upstream's functions: every export of `src/upstream.ts`, and the seed
 * and randomness lengths.
 */
export const layoutConstants: readonly LayoutConstant[] = [
	{ name: "seedBytes", value: seedBytes, expression: "MLDSA_SEEDBYTES" },
	{ name: "randomnessBytes", value: randomnessBytes, expression: "MLDSA_RNDBYTES" },
	{ name: "publicKeyHashBytes", value: upstream.publicKeyHashBytes, expression: "MLDSA_TRBYTES" },
	{
		name: "publicKeyHashOffset",
		value: upstream.publicKeyHashOffset,
		expression: "MLDSA_SK_TR_OFFSET",
	},
	{
		name: "messageRepresentativeBytes",
		value: upstream.messageRepresentativeBytes,
		expression: "MLDSA_CRHBYTES",
	},
	{
		name: "prefixBytes",
		value: upstream.prefixBytes,
		expression: "MLD_DOMAIN_SEPARATION_MAX_BYTES",
	},
	{
		name: "shakeStateBytes",
		value: upstream.shakeStateBytes,
		expression: "sizeof(mld_shake256ctx)",
	},
	{
		name: "shakeStateAlignment",
		value: upstream.shakeStateAlignment,
		expression: "_Alignof(mld_shake256ctx)",
	},
	{ name: "pureMlDsa", value: upstream.pureMlDsa, expression: "MLD_PREHASH_NONE" },
];

function staticAssert(expression: string, value: number, name: string): string {
	return `_Static_assert(${expression} == ${String(value)}, ${JSON.stringify(`${expression} must equal ${name}, which is ${String(value)}`)});`;
}

/** The layout probe's lines, one `_Static_assert` per constant. */
export function layoutProbe(constants: readonly LayoutConstant[]): string {
	return constants
		.map(({ expression, value, name }) => staticAssert(expression, value, name))
		.join("\n");
}

/** A `_Static_assert` that must fail, because it expects the first constant plus one. */
export function failingLayoutLine(constants: readonly LayoutConstant[]): string {
	const [first] = constants;
	if (first === undefined) {
		throw new Error("The layout probe needs at least one constant.");
	}
	return staticAssert(first.expression, first.value + 1, first.name);
}

/**
 * Splits the output of `build.sh probe` into its sections, keyed by the text
 * after `@@ ` on each section line.
 *
 * @throws CommandFailed if the output doesn't start with a section line or repeats one.
 */
export function probeSections(output: string): ReadonlyMap<string, readonly string[]> {
	const sections = new Map<string, string[]>();
	let current: string[] | undefined = undefined;
	for (const line of output.split("\n")) {
		if (line.startsWith("@@ ")) {
			const name = line.slice(3);
			if (sections.has(name)) {
				throw new CommandFailed(`The probe printed the section "${name}" twice.`);
			}
			current = [];
			sections.set(name, current);
		} else if (current !== undefined) {
			current.push(line);
		} else if (line !== "") {
			throw new CommandFailed(`The probe printed \`${line}\` before its first section.`);
		}
	}
	return sections;
}

/** The parameter sets that the probe covered, from its `prototypes N` sections. */
function probedParameterSets(sections: ReadonlyMap<string, readonly string[]>): readonly string[] {
	return [...sections.keys()].flatMap((name) => /^prototypes (\d+)$/.exec(name)?.[1] ?? []);
}

/**
 * The C-prototype snapshot: a heading per parameter set, then each
 * declaration that clang printed for it, without clang's `Printing` lines.
 */
export function prototypeLines(
	sections: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
	return probedParameterSets(sections).flatMap((parameterSet) => [
		`# ML-DSA-${parameterSet}`,
		...(sections.get(`prototypes ${parameterSet}`) ?? []).filter(
			(line) => line !== "" && !/^Printing \S+:$/.test(line),
		),
	]);
}

/** The `MLD_CONFIG_*` macros of one `-dM -E` output, keyed by name, each with its whole line. */
function configMacros(lines: readonly string[]): ReadonlyMap<string, string> {
	const macros = new Map<string, string>();
	for (const line of lines) {
		const name = /^#define (MLD_CONFIG_\w+)/.exec(line)?.[1];
		if (name !== undefined) {
			macros.set(name, line.trimEnd());
		}
	}
	return macros;
}

/**
 * The config diff: a heading per parameter set, then, in macro order, `-`
 * before each CT macro that the shipped config lacks or defines otherwise,
 * and `+` before each shipped macro that the CT config lacks or defines
 * otherwise.
 */
export function configDiffLines(
	sections: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
	const ct = configMacros(sections.get("config ct") ?? []);
	return probedParameterSets(sections).flatMap((parameterSet) => {
		const shipped = configMacros(sections.get(`config ${parameterSet}`) ?? []);
		const names = [...new Set([...ct.keys(), ...shipped.keys()])].toSorted();
		return [
			`# ML-DSA-${parameterSet} against upstream's CT config`,
			...names.flatMap((name) => {
				const before = ct.get(name);
				const after = shipped.get(name);
				if (before === after) {
					return [];
				}
				return [
					...(before === undefined ? [] : [`- ${before}`]),
					...(after === undefined ? [] : [`+ ${after}`]),
				];
			}),
		];
	});
}

/** What the header checks compare. */
export interface HeaderFacts {
	/** The sections of the probe's output. */
	readonly sections: ReadonlyMap<string, readonly string[]>;
	/** The name of each function that the module exports. */
	readonly functionNames: readonly string[];
	/** The text of `prototypes.txt`, or `undefined` when it is missing. */
	readonly committedPrototypes: string | undefined;
	/** The text of `config-diff.txt`, or `undefined` when it is missing. */
	readonly committedConfigDiff: string | undefined;
}

/**
 * Returns one message per difference that the header checks find. When the
 * probe printed no parameter set or no CT config, the comparisons would only
 * add noise, so that message is the only one.
 */
export function headerFailures(facts: HeaderFacts): readonly string[] {
	const { sections } = facts;
	const parameterSets = probedParameterSets(sections);
	if (parameterSets.length === 0) {
		return ["The probe printed no prototypes section, so it compiled no parameter set."];
	}
	if (!sections.has("config ct")) {
		return ["The probe printed no macros for upstream's CT config."];
	}

	const failures: string[] = [];

	const declarations = prototypeLines(sections);
	for (const name of facts.functionNames) {
		if (!declarations.some((line) => line.includes(` ${name}(`))) {
			failures.push(
				`Upstream's headers declare no function ${name}, which the module exports and the package calls.`,
			);
		}
	}
	failures.push(
		...snapshotFailures(
			prototypesFile,
			"the pinned clang's dump of upstream's headers",
			facts.committedPrototypes,
			declarations,
		),
	);

	for (const parameterSet of parameterSets) {
		if (!sections.has(`layout ${parameterSet} passed`)) {
			const messages = sections.get(`layout ${parameterSet} failed`);
			failures.push(
				messages === undefined
					? `The probe printed no layout result for ML-DSA-${parameterSet}.`
					: `The layout probe failed for ML-DSA-${parameterSet}, so a constant of the package differs from upstream's headers. clang reports:\n${messages.join("\n").trim()}`,
			);
		}
	}
	const failing = sections.get("failing-layout 44 failed");
	if (failing === undefined || !failing.some((line) => line.includes("static assertion failed"))) {
		failures.push(
			"The failing layout line didn't fail with a static assertion, so the layout probe may not evaluate its assertions.",
		);
	}

	failures.push(
		...snapshotFailures(
			configDiffFile,
			"the diff of the shipped config against upstream's CT config",
			facts.committedConfigDiff,
			configDiffLines(sections),
		),
	);
	return failures;
}
