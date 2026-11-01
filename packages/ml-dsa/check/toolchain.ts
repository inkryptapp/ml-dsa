/**
 * The toolchain match. The module's `producers` section must name only the
 * pinned clang, whose major must be the newest clang major in the CT matrix
 * at the pin, and the build's `-O` level must be one that the CT matrix tests
 * for that clang. Record 0001 in docs/adr/ holds the reasons.
 */
import { newestClangLevels, newestClangMajor, type CtMatrix } from "../../../scripts/ct-matrix.ts";
import { buildScript, ctWorkflowFile, moduleFile } from "./files.ts";
import type { ProducerFields } from "./wasm-binary.ts";

/** What the toolchain match compares, each read from its own source. */
export interface ToolchainFacts {
	/** The fields of each `producers` section of the module, in module order. */
	readonly producerSections: readonly ProducerFields[];
	/** The CT matrix of `ct-tests.yml` at the pin. */
	readonly matrix: CtMatrix;
	/** Each `-O` word of the build script, in order. */
	readonly optimizationLevels: readonly string[];
	/** The version of the clang that the flake takes from upstream's nixpkgs, such as `22.1.5`. */
	readonly pinnedClang: string;
}

const workflow = `the CT matrix in ${ctWorkflowFile}`;

/**
 * Returns each `-O` word of a build script, skipping comments. A word that
 * starts with `#` after a space starts a comment, as in bash. Words also end
 * at parentheses, `=`, and `;`, so an array or a variable assignment such as
 * `cflags=(-O3` or `level=-O2` can't hide a flag.
 */
export function optimizationLevels(script: string): readonly string[] {
	return script
		.split("\n")
		.flatMap((line) => line.replace(/(?:^|\s)#.*$/, "").split(/[\s()=;]+/))
		.map((word) => word.replaceAll(/["']/g, ""))
		.filter((word) => word.startsWith("-O"));
}

function majorOf(version: string): number | undefined {
	const major = /^(\d+)\./.exec(version)?.[1];
	return major === undefined ? undefined : Number(major);
}

/** Returns one message per rule of the toolchain match that the facts break. */
export function toolchainFailures(facts: ToolchainFacts): readonly string[] {
	const failures: string[] = [];
	const newest = newestClangMajor(facts.matrix);
	if (newest === undefined) {
		failures.push(`${workflow} names no clang.`);
	}

	const [producers, ...extraSections] = facts.producerSections;
	const processedBy = producers?.get("processed-by") ?? [];
	const listed = processedBy.map(({ name, version }) => `${name} ${version}`).join(", ");
	if (producers === undefined) {
		failures.push(
			`${moduleFile} has no producers section, so the check can't read which clang built it.`,
		);
	} else if (extraSections.length > 0) {
		failures.push(
			`${moduleFile} has ${String(facts.producerSections.length)} producers sections, but it must have one.`,
		);
	} else if (
		processedBy.length !== 1 ||
		processedBy[0]?.name !== "clang" ||
		processedBy[0].version !== facts.pinnedClang
	) {
		failures.push(
			`The producers section of ${moduleFile} lists "${listed}" as processed-by, but it must list only the pinned clang ${facts.pinnedClang}.`,
		);
	}

	const builtWith = processedBy.length === 1 ? processedBy[0] : undefined;
	const major = builtWith?.name === "clang" ? majorOf(builtWith.version) : undefined;
	if (major !== undefined && newest !== undefined && major !== newest) {
		failures.push(
			`${moduleFile} was built with clang ${String(major)}, but the newest clang in ${workflow} is clang ${String(newest)}. A pin bump moves the toolchain to the newest clang major in the CT matrix.`,
		);
	}

	const [level, ...others] = facts.optimizationLevels;
	if (level === undefined || others.length > 0) {
		failures.push(
			`${buildScript} must pass exactly one -O flag, but it passes ${facts.optimizationLevels.length === 0 ? "none" : facts.optimizationLevels.join(" ")}.`,
		);
	} else if (newest !== undefined) {
		const tested = newestClangLevels(facts.matrix);
		if (!tested.has(level)) {
			failures.push(
				`${buildScript} passes ${level}, but ${workflow} tests clang ${String(newest)} only at ${[...tested.keys()].join(" ") || "no level"}.`,
			);
		}
	}
	return failures;
}
