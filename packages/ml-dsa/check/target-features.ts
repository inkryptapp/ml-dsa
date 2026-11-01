/**
 * The target features. The module's `target_features` section must list
 * exactly `+bulk-memory-opt`, and `wasm-tools validate` with the allowlist,
 * `mvp,bulk-memory-opt`, must accept the module. Each feature that the
 * pinned `llc -mtriple=wasm32 -mattr=help` lists outside the allowlist has a
 * row in {@link featureTable} and a minimal fixture in `features/`, named
 * after clang's name for the feature. The allowlist with the row's
 * prerequisites must reject the fixture, and the same list with the feature
 * added must accept it. So the fixtures prove that the validator rejects each
 * feature that clang can enable.
 *
 * A feature that the pinned wasm-tools doesn't know, such as `fp16`, can't be
 * added to the list. Its fixture must fail at a recorded offset with a
 * recorded message under the allowlist with its prerequisites and under
 * `--features=all`, and a last run must show that wasm-tools doesn't know the
 * name. A compiler witness then proves that the fixture holds
 * the instruction: clang's assembly output must name it, and assembling that
 * output must give the fixture's bytes. Record 0003 in docs/adr/ holds the
 * reasons.
 */
import { moduleFile } from "./files.ts";
import { Reader, type WasmModule } from "./wasm-binary.ts";

/** The folder of the feature fixtures, relative to the repo root. */
export const featureFolder = "packages/ml-dsa/check/features";

/** This file, which holds the feature table. */
const tableFile = "packages/ml-dsa/check/target-features.ts";

/** The features that the module may use, as clang names them. */
const clangAllowlist = ["bulk-memory-opt"];

/** The same features as wasm-tools names them, with the MVP. */
const allowlist = "mvp,bulk-memory-opt";

/** The fixture with `memory.copy` and `memory.fill`, which the allowlist alone must accept. */
const positiveFixture = "bulk-memory-opt";

/** A feature that clang can enable and the module must not use. */
export type FeatureRow = {
	/**
	 * clang's name, as `llc -mattr=help` lists it. The fixture is
	 * `features/<clang>.wat`, or `features/<clang>.wasm` when the text format
	 * can't hold it.
	 */
	readonly clang: string;
	/** The wasm-tools features that the fixture needs besides this one. */
	readonly prerequisites: readonly string[];
} & (
	| {
			/** wasm-tools' name for the feature. */
			readonly wasmTools: string;
	  }
	| {
			/** The pinned wasm-tools doesn't know the feature. */
			readonly wasmTools: undefined;
			/** Where and how the validator rejects the fixture once the prerequisites are on. */
			readonly rejection: { readonly offset: number; readonly message: string };
			/**
			 * The compiler witness. `features/<clang>.c` compiles with `-m<feature>`
			 * for each of `features` to assembly that names `instruction`, and the
			 * assembled and linked output, with `export` exported, equals the fixture.
			 */
			readonly witness: {
				readonly features: readonly string[];
				readonly instruction: string;
				readonly export: string;
			};
	  }
);

/** The table that maps each clang feature to wasm-tools' name, with each fixture's prerequisites. */
export const featureTable: readonly FeatureRow[] = [
	{ clang: "atomics", wasmTools: "threads", prerequisites: [] },
	{ clang: "bulk-memory", wasmTools: "bulk-memory", prerequisites: [] },
	{ clang: "call-indirect-overlong", wasmTools: "call-indirect-overlong", prerequisites: [] },
	{ clang: "exception-handling", wasmTools: "exceptions", prerequisites: [] },
	{ clang: "extended-const", wasmTools: "extended-const", prerequisites: [] },
	{
		clang: "fp16",
		wasmTools: undefined,
		prerequisites: ["simd"],
		rejection: { offset: 0x3e, message: "unknown 0xfd subopcode: 0x120" },
		witness: { features: ["simd128", "fp16"], instruction: "f16x8.splat", export: "splat" },
	},
	{ clang: "gc", wasmTools: "gc", prerequisites: ["reference-types"] },
	{ clang: "multimemory", wasmTools: "multi-memory", prerequisites: [] },
	{ clang: "multivalue", wasmTools: "multi-value", prerequisites: [] },
	{ clang: "mutable-globals", wasmTools: "mutable-global", prerequisites: [] },
	{ clang: "nontrapping-fptoint", wasmTools: "saturating-float-to-int", prerequisites: [] },
	{ clang: "reference-types", wasmTools: "reference-types", prerequisites: [] },
	{ clang: "relaxed-simd", wasmTools: "relaxed-simd", prerequisites: ["simd"] },
	{ clang: "sign-ext", wasmTools: "sign-extension", prerequisites: [] },
	{ clang: "simd128", wasmTools: "simd", prerequisites: [] },
	{ clang: "tail-call", wasmTools: "tail-call", prerequisites: [] },
	{ clang: "wide-arithmetic", wasmTools: "wide-arithmetic", prerequisites: ["multi-value"] },
];

/**
 * Returns the messages for the module's `target_features` sections, which
 * must be one section with exactly the entry `+bulk-memory-opt`.
 */
export function targetFeatureFailures(module: WasmModule): readonly string[] {
	const sections = module.customSections.filter((section) => section.name === "target_features");
	const [section, ...others] = sections;
	if (section === undefined) {
		return [
			`${moduleFile} has no target_features section, so the check can't read which features the compiler used.`,
		];
	}
	if (others.length > 0) {
		return [
			`${moduleFile} has ${String(sections.length)} target_features sections, but it must have one.`,
		];
	}
	// Each entry is a prefix byte, such as `+` for a used feature, and a name.
	const reader = new Reader(section.bytes, 0, section.bytes.length);
	const entries = reader.vector(() => String.fromCharCode(reader.byte()) + reader.name());
	if (!reader.atEnd()) {
		reader.fail("the target_features section has bytes after its last entry.");
	}
	const expected = clangAllowlist.map((feature) => `+${feature}`);
	if (
		entries.length !== expected.length ||
		entries.some((entry, index) => entry !== expected[index])
	) {
		return [
			`The target_features section of ${moduleFile} lists ${entries.join(", ") || "nothing"}, but it must list exactly ${expected.join(", ")}.`,
		];
	}
	return [];
}

function features(...lists: readonly (readonly string[])[]): string {
	return [allowlist, ...lists.flat()].join(",");
}

function command(list: string): string {
	return `\`wasm-tools validate --features=${list}\``;
}

/** What one validator run gave. */
interface RunResult {
	readonly passed: boolean;
	/** The validator's messages. */
	readonly log: string;
}

/** One validator run, with the rule that its result must meet. */
interface Run {
	/** The committed module's path, or a fixture's name. */
	readonly target: string;
	readonly features: string;
	/** Returns the failure for a result that breaks the rule, if it does. `file` names the target's file. */
	readonly check: (result: RunResult, file: string) => string | undefined;
}

/** The runs of one row's fixture. */
function rowRuns(row: FeatureRow): readonly Run[] {
	const target = row.clang;
	const rejects = (list: string): Run => ({
		target,
		features: list,
		check: ({ passed }, file) =>
			passed
				? `${command(list)} accepts ${file}, so the fixture doesn't prove that the allowlist rejects ${row.clang}.`
				: undefined,
	});
	if (row.wasmTools !== undefined) {
		const withFeature = features(row.prerequisites, [row.wasmTools]);
		return [
			rejects(features(row.prerequisites)),
			{
				target,
				features: withFeature,
				check: ({ passed, log }, file) =>
					passed
						? undefined
						: `${command(withFeature)} rejects ${file}, so the fixture tests something other than ${row.clang}:\n${log}`,
			},
		];
	}
	const expected = `${row.rejection.message} (at offset 0x${row.rejection.offset.toString(16)})`;
	const rejectsAtOffset = (list: string): Run => ({
		target,
		features: list,
		check: ({ passed, log }, file) => {
			if (passed) {
				return `${command(list)} accepts ${file}, so wasm-tools knows a feature that enables ${row.clang}. Give the row its wasm-tools name.`;
			}
			return log.includes(expected)
				? undefined
				: `${command(list)} must reject ${file} with \`${expected}\`, but it reports:\n${log}`;
		},
	});
	return [
		rejects(features()),
		rejectsAtOffset(features(row.prerequisites)),
		rejectsAtOffset("all"),
		// Record 0003 allows the exception only for a feature that wasm-tools
		// doesn't know, so this run proves that it doesn't know the name.
		{
			target,
			features: `mvp,${row.clang}`,
			check: ({ log }) =>
				log.includes(`unknown feature \`${row.clang}\``)
					? undefined
					: `wasm-tools knows the feature name ${row.clang}, so the row's exception lapses. Give the row its wasm-tools name.`,
		},
	];
}

/** Every validator run of the probe for the table, in the order that the probe runs them. */
function runsOf(table: readonly FeatureRow[]): readonly Run[] {
	return [
		{
			target: moduleFile,
			features: allowlist,
			check: ({ passed, log }, file) =>
				passed ? undefined : `${command(allowlist)} rejects ${file}:\n${log}`,
		},
		{
			target: positiveFixture,
			features: allowlist,
			check: ({ passed, log }, file) =>
				passed
					? undefined
					: `${command(allowlist)} rejects ${file}, the fixture that must pass with the allowlist alone:\n${log}`,
		},
		{
			target: positiveFixture,
			features: "mvp",
			check: ({ passed }, file) =>
				passed
					? `${command("mvp")} accepts ${file}, so the fixture doesn't use bulk-memory-opt.`
					: undefined,
		},
		...table.flatMap(rowRuns),
	];
}

/** The arguments of `features.sh` for the table: every validator run, then each witness. */
export function featureProbeArguments(table: readonly FeatureRow[]): readonly string[] {
	return [
		...runsOf(table).map((run) => `${run.target}=${run.features}`),
		...table.flatMap((row) =>
			row.wasmTools === undefined
				? [`witness:${row.clang}:${row.witness.export}=${row.witness.features.join(",")}`]
				: [],
		),
	];
}

/** The features that the pinned llc lists, from its output after "Available features for this target:". */
function llcFeatures(lines: readonly string[]): readonly string[] {
	const start = lines.findIndex((line) => line.startsWith("Available features for this target:"));
	if (start === -1) {
		return [];
	}
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line !== "" && !line.startsWith(" ")) {
			break;
		}
		const feature = /^\s+([a-z0-9-]+)\s+- /.exec(line)?.[1];
		if (feature !== undefined) {
			names.push(feature);
		}
	}
	return names;
}

/** What the feature probe compares. */
export interface FeatureFacts {
	/** The sections of the probe's output. */
	readonly sections: ReadonlyMap<string, readonly string[]>;
	readonly table: readonly FeatureRow[];
	/** The file name of each `.wat` and `.wasm` fixture in {@link featureFolder}. */
	readonly fixtures: readonly string[];
}

/** Returns one message per rule of the target features that the probe's results break. */
export function featureProbeFailures(facts: FeatureFacts): readonly string[] {
	const { sections, table } = facts;
	const listed = llcFeatures(sections.get("llc") ?? []);
	if (listed.length === 0) {
		return ["The pinned `llc -mtriple=wasm32 -mattr=help` lists no wasm features."];
	}

	const failures: string[] = [];
	const rows = new Set(table.map((row) => row.clang));
	for (const feature of listed) {
		if (!clangAllowlist.includes(feature) && !rows.has(feature)) {
			failures.push(
				`The pinned llc lists the wasm feature ${feature}, but ${tableFile} has no row for it, so no fixture proves that the allowlist rejects it.`,
			);
		}
	}
	for (const row of table) {
		if (!listed.includes(row.clang)) {
			failures.push(`${tableFile} has a row for ${row.clang}, which the pinned llc doesn't list.`);
		}
	}
	/** Each fixture's file, keyed by its name without the extension. */
	const fixtureFiles = new Map(
		facts.fixtures.map((file) => [file.replace(/\.(?:wat|wasm)$/, ""), `${featureFolder}/${file}`]),
	);
	for (const [fixture, file] of fixtureFiles) {
		if (fixture !== positiveFixture && !rows.has(fixture)) {
			failures.push(`${file} has no row in ${tableFile}.`);
		}
	}

	// A fixture for a feature that wasm-tools doesn't know is a binary.
	const expectedFixtures: readonly (readonly [string, string])[] = [
		[positiveFixture, "wat"],
		...table.map((row) => [row.clang, row.wasmTools === undefined ? "wasm" : "wat"] as const),
	];
	for (const [fixture, extension] of expectedFixtures) {
		if (!fixtureFiles.has(fixture)) {
			failures.push(`The fixture ${featureFolder}/${fixture}.${extension} is missing.`);
		}
	}

	for (const run of runsOf(table)) {
		const file = run.target === moduleFile ? moduleFile : fixtureFiles.get(run.target);
		if (file === undefined) {
			continue;
		}
		const key = `validate ${run.target} ${run.features}`;
		const passed = sections.get(`${key} passed`);
		const log = passed ?? sections.get(`${key} failed`);
		const failure =
			log === undefined
				? `The probe printed no result for ${command(run.features)} on ${run.target}.`
				: run.check({ passed: passed !== undefined, log: log.join("\n").trim() }, file);
		if (failure !== undefined) {
			failures.push(failure);
		}
	}

	for (const row of table) {
		const file = fixtureFiles.get(row.clang);
		if (row.wasmTools !== undefined || file === undefined) {
			continue;
		}
		const source = `${featureFolder}/${row.clang}.c`;
		const assembly = sections.get(`witness ${row.clang} assembly`);
		if (
			assembly === undefined ||
			!assembly.some((line) => line.trim().split(/\s+/)[0] === row.witness.instruction)
		) {
			failures.push(`clang's assembly for ${source} doesn't name ${row.witness.instruction}.`);
		}
		const witness = sections.get(`witness ${row.clang} module`)?.join("").trim();
		const fixture = sections.get(`fixture ${row.clang}`)?.join("").trim();
		if (witness === undefined || fixture === undefined || witness !== fixture) {
			failures.push(`Assembling clang's assembly for ${source} gives other bytes than ${file}.`);
		}
	}
	return failures;
}
