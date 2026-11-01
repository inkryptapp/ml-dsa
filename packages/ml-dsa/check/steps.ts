import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CommandFailed, nix, root, type Step } from "../../../scripts/check-step.ts";
import {
	ctDefinitions,
	CtMatrixError,
	readCtActionDefinitions,
	readCtMatrix,
} from "../../../scripts/ct-matrix.ts";
import { submodulePath } from "../../../scripts/pin-guard.ts";
import { buildScriptFailures, derivationFailures } from "./build-lint.ts";
import { buildScript, ctActionFile, ctWorkflowFile, moduleFile } from "./files.ts";
import {
	declarationFailures,
	exportEntries,
	exportLine,
	exportListFile,
	importAndMemoryFailures,
	sizeFailures,
	type BuildSizes,
} from "./module-interface.ts";
import {
	nativeSystem,
	plannedBuilds,
	rebuildFailures,
	systems,
	type Build,
	type BuildResult,
	type System,
} from "./rebuild.ts";
import { snapshotFailures } from "./snapshot.ts";
import { optimizationLevels, toolchainFailures } from "./toolchain.ts";
import {
	configDiffFile,
	failingLayoutLine,
	headerFailures,
	layoutConstants,
	layoutProbe,
	probeSections,
	prototypesFile,
} from "./upstream-headers.ts";
import { producerSections, readModule, WasmFormatError, type WasmModule } from "./wasm-binary.ts";

const sizesFile = "packages/ml-dsa/wasm/sizes.json";
const includeFolder = "packages/ml-dsa/wasm/include";
const stackMarginTest = "packages/ml-dsa/test/stack-margin.test.ts";
const vectorTest = "packages/ml-dsa/test/vectors.test.ts";

// The rebuild step has already evaluated the flake, whose rules in
// nix/lib.nix validate the file, so the checks read only the sizes that they
// compare.
const Sizes = z.looseObject({ memoryBytes: z.number(), stackBytes: z.number() });

function installable(system: System): string {
	return `.#packages.${system}.wasm`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function buildLintFailures(): readonly string[] {
	const script = readFileSync(join(root, buildScript), "utf8");
	const derivations: unknown = JSON.parse(
		nix(["derivation", "show", ...systems.map(installable)]).toString("utf8"),
	);
	return [...buildScriptFailures(buildScript, script), ...derivationFailures(derivations)];
}

function buildModule(build: Build): BuildResult {
	const emulationFlags = build.emulated ? ["--option", "extra-platforms", build.system] : [];
	const target = installable(build.system);
	const storePath = nix(["build", "--no-link", "--print-out-paths", ...emulationFlags, target])
		.toString("utf8")
		.trim();
	if (!/^\/nix\/store\/[0-9a-z]{32}-mldsa-wasm$/.test(storePath)) {
		throw new CommandFailed(
			`\`nix build\` printed ${JSON.stringify(storePath)} instead of one store path.`,
		);
	}
	// The rebuild runs the compiler even when the store already holds the
	// output, and Nix fails it unless both runs give the same bytes.
	nix(["build", "--no-link", "--rebuild", ...emulationFlags, target]);
	const hash = sha256(nix(["store", "cat", `${storePath}/mldsa.wasm`]));
	console.log(`  ${build.system} build (${build.emulated ? "emulated" : "native"}): ${hash}`);
	return { ...build, storePath, hash };
}

/** Runs `check` with the host's own system, or fails when the build image has none for the host. */
function onNativeSystem(check: (native: System) => readonly string[]): readonly string[] {
	const native = nativeSystem(process.arch);
	if (native === undefined) {
		return [`The build image runs only on arm64 and x86_64 hosts, not on ${process.arch}.`];
	}
	return check(native);
}

function moduleRebuildFailures(native: System, nativeOnly: boolean): readonly string[] {
	const path = join(root, moduleFile);
	const committedHash = existsSync(path) ? sha256(readFileSync(path)) : undefined;
	console.log(`  ${moduleFile}: ${committedHash ?? "missing"}`);
	const results = plannedBuilds(native, nativeOnly).map(buildModule);
	return rebuildFailures(moduleFile, committedHash, results);
}

function readIfPresent(file: string): string | undefined {
	const path = join(root, file);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function readSizes(): BuildSizes {
	return Sizes.parse(JSON.parse(readFileSync(join(root, sizesFile), "utf8")));
}

function readCommittedModule(): WasmModule {
	return readModule(readFileSync(join(root, moduleFile)));
}

/**
 * Runs `check`, and turns an error that says the committed module or
 * upstream's CT workflow or action has a shape that the check can't read into
 * a failure.
 */
function failOnUnreadable(check: () => readonly string[]): readonly string[] {
	try {
		return check();
	} catch (error) {
		if (error instanceof WasmFormatError) {
			return [`The check can't read ${moduleFile}. ${error.message}`];
		}
		if (error instanceof CtMatrixError) {
			return [`The check can't follow upstream's CT setup in ${submodulePath}. ${error.message}`];
		}
		throw error;
	}
}

function toolchainMatchFailures(native: System): readonly string[] {
	const pinnedClang = nix(["eval", "--raw", `.#packages.${native}.clang.version`])
		.toString("utf8")
		.trim();
	console.log(`  the pinned clang: ${pinnedClang}`);
	return failOnUnreadable(() =>
		toolchainFailures({
			producerSections: producerSections(readCommittedModule()),
			matrix: readCtMatrix(readFileSync(join(root, ctWorkflowFile), "utf8")),
			optimizationLevels: optimizationLevels(readFileSync(join(root, buildScript), "utf8")),
			pinnedClang,
		}),
	);
}

function interfaceFailures(): readonly string[] {
	return failOnUnreadable(() => {
		const module = readCommittedModule();
		const entries = exportEntries(module);
		return [
			...snapshotFailures(
				exportListFile,
				"the committed module",
				readIfPresent(exportListFile),
				entries.map(exportLine),
			),
			...importAndMemoryFailures(module),
			...sizeFailures(module, readSizes()),
			...declarationFailures(root, entries),
		];
	});
}

/**
 * Runs `build.sh probe` with the pinned clang on the working tree's vendored
 * source and include folder, then compares what it prints. The pin guard keeps
 * the vendored source at the pin, and the build also reads the include
 * folder's files from the working tree, untracked files aside. The probe's CT
 * config comes from upstream's CT workflow and action at the pin, for the
 * build's `-O` level, which the toolchain match has already checked.
 */
function upstreamHeaderFailures(native: System): readonly string[] {
	return failOnUnreadable(() => {
		const [level = ""] = optimizationLevels(readFileSync(join(root, buildScript), "utf8"));
		const definitions = ctDefinitions(
			readCtMatrix(readFileSync(join(root, ctWorkflowFile), "utf8")),
			readCtActionDefinitions(readFileSync(join(root, ctActionFile), "utf8")),
			level,
		);
		console.log(`  upstream's CT definitions for ${level}: ${definitions.join(" ")}`);
		return headerProbeFailures(native, definitions);
	});
}

function headerProbeFailures(native: System, ctConfig: readonly string[]): readonly string[] {
	const sizes = readSizes();
	const output = nix([
		"shell",
		`.#packages.${native}.clang`,
		"--command",
		"env",
		"CC=clang",
		`MLDSA_NATIVE=${join(root, submodulePath)}`,
		`INCLUDE=${join(root, includeFolder)}`,
		`MEMORY_SIZE=${String(sizes.memoryBytes)}`,
		`STACK_SIZE=${String(sizes.stackBytes)}`,
		"bash",
		buildScript,
		"probe",
		layoutProbe(layoutConstants),
		failingLayoutLine(layoutConstants),
		...ctConfig,
	]).toString("utf8");
	return headerFailures({
		sections: probeSections(output),
		functionNames: exportEntries(readCommittedModule()).flatMap((entry) =>
			entry.kind === "func" ? [entry.name] : [],
		),
		committedPrototypes: readIfPresent(prototypesFile),
		committedConfigDiff: readIfPresent(configDiffFile),
	});
}

/** Runs one test file and fails when a test in it fails. */
function testFileFailures(file: string): readonly string[] {
	// When Vitest detects a coding agent, such as through `AI_AGENT`, its
	// default reporter hides a passing test's output, and the tables that these
	// files print are that output.
	const args = ["test", "run", "--silent=false", file];
	const result = spawnSync(join(root, "node_modules/.bin/vp"), args, {
		cwd: root,
		stdio: "inherit",
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		return [`\`vp ${args.join(" ")}\` failed. Its output above says which cases failed and why.`];
	}
	return [];
}

/** The wasm port's steps of the check command, in order. */
export function wasmSteps(options: { readonly nativeOnly: boolean }): readonly Step[] {
	return [
		{ name: "build lint", run: buildLintFailures },
		{
			name: "wasm module rebuilds",
			run: () => onNativeSystem((native) => moduleRebuildFailures(native, options.nativeOnly)),
		},
		{ name: "toolchain match", run: () => onNativeSystem(toolchainMatchFailures) },
		{ name: "module interface", run: interfaceFailures },
		{ name: "upstream headers", run: () => onNativeSystem(upstreamHeaderFailures) },
		// The stack-margin test prints the wasm stack peak of every operation.
		{ name: "stack margin", run: () => testFileFailures(stackMarginTest) },
		// The vector test routes the ACVP and Wycheproof cases through the
		// committed module, and prints the count per path and the cases per
		// segment.
		{ name: "vectors", run: () => testFileFailures(vectorTest) },
	];
}
