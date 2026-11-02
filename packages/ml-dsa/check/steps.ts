import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { manifestHashes } from "../../../scripts/vector-manifest.ts";
import { buildScriptFailures, derivationFailures } from "./build-lint.ts";
import { expectedCounts } from "./expected-counts.ts";
import { buildScript, ctActionFile, ctWorkflowFile, moduleFile } from "./files.ts";
import {
	debugInfoFailures,
	hostPathFailures,
	negativeFixtureFailures,
	prefixMapNames,
	scanPatterns,
} from "./host-paths.ts";
import {
	countTotals,
	declassificationFailures,
	instructionCountFailures,
} from "./instruction-counts.ts";
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
import { attwFailures, copiedFiles, packageFailures, tarballFilesFile } from "./package-checks.ts";
import { snapshotFailures } from "./snapshot.ts";
import {
	compareTarballs,
	packedTarballName,
	readTarball,
	TarballFormatError,
	type PackedTarball,
	type TarballFiles,
} from "./tarball.ts";
import {
	featureFolder,
	featureProbeArguments,
	featureProbeFailures,
	featureTable,
	targetFeatureFailures,
} from "./target-features.ts";
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
const featureScript = "packages/ml-dsa/check/features.sh";
const packScript = "packages/ml-dsa/check/pack.sh";

/** The folder that the package build writes each system's tarball to. CI uploads it. */
const packedFolder = "packages/ml-dsa/packed";

// The rebuild step has already evaluated the flake, whose rules in
// nix/lib.nix validate the file, so the checks read only the sizes that they
// compare.
const Sizes = z.looseObject({ memoryBytes: z.number(), stackBytes: z.number() });

/** The roots that the derivation hands the build, as `nix eval` prints them. */
const BuildRoots = z.object({ MLDSA_NATIVE: z.string(), INCLUDE: z.string() });

function installable(system: System, name = "wasm"): string {
	return `.#packages.${system}.${name}`;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function buildLintFailures(): readonly string[] {
	const script = readFileSync(join(root, buildScript), "utf8");
	const derivations: unknown = JSON.parse(
		nix([
			"derivation",
			"show",
			...systems.flatMap((system) => [installable(system), installable(system, "wasm-debug")]),
		]).toString("utf8"),
	);
	return [...buildScriptFailures(buildScript, script), ...derivationFailures(derivations)];
}

/**
 * Builds `target` and returns its store path, whose name must be `name`. A
 * build that the store already holds returns at once.
 */
function buildOutput(target: string, name: string, flags: readonly string[] = []): string {
	const storePath = nix(["build", "--no-link", "--print-out-paths", ...flags, target])
		.toString("utf8")
		.trim();
	if (!new RegExp(`^/nix/store/[0-9a-z]{32}-${name}$`).test(storePath)) {
		throw new CommandFailed(
			`\`nix build\` printed ${JSON.stringify(storePath)} instead of one store path.`,
		);
	}
	return storePath;
}

function buildModule(build: Build): BuildResult {
	const emulationFlags = build.emulated ? ["--option", "extra-platforms", build.system] : [];
	const target = installable(build.system);
	const storePath = buildOutput(target, "mldsa-wasm", emulationFlags);
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
 * Runs `check`, and turns an error that says a module or upstream's CT
 * workflow or action has a shape that the check can't read into a failure.
 * `module` names the module that `check` reads, the committed one by default.
 */
function failOnUnreadable(
	check: () => readonly string[],
	module: string = moduleFile,
): readonly string[] {
	try {
		return check();
	} catch (error) {
		if (error instanceof WasmFormatError) {
			return [`The check can't read ${module}. ${error.message}`];
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

/** Reads the unstripped twin of the native build, which the rebuild step has already built. */
function readTwinBytes(native: System): Buffer {
	const storePath = buildOutput(installable(native), "mldsa-wasm");
	return nix(["store", "cat", `${storePath}/mldsa.unstripped.wasm`]);
}

function readVendoredFile(file: string): string | undefined {
	return readIfPresent(`${submodulePath}/${file}`);
}

function instructionCountStepFailures(native: System): readonly string[] {
	return failOnUnreadable(() => {
		const shipped = readCommittedModule();
		const twinBytes = readTwinBytes(native);
		return failOnUnreadable(() => {
			const twin = readModule(twinBytes);
			const failures = instructionCountFailures({ shipped, twin, expected: expectedCounts });
			if (failures.length === 0) {
				const totals = [...countTotals(twin)].map(([name, count]) => `${String(count)} ${name}`);
				console.log(`  the twin's counts: ${totals.join(", ")}`);
			}
			return [...failures, ...declassificationFailures(expectedCounts, readVendoredFile)];
		}, "the unstripped twin");
	});
}

/** The file names of the `.wat` and `.wasm` fixtures in the feature folder. */
function featureFixtures(): readonly string[] {
	return readdirSync(join(root, featureFolder)).filter((file) => /\.(?:wat|wasm)$/.test(file));
}

/**
 * Runs `features.sh` with the pinned clang, wasm-ld, llc, and wasm-tools,
 * which validates the committed module and the feature fixtures, and runs
 * each compiler witness.
 */
function targetFeatureStepFailures(native: System): readonly string[] {
	const sectionFailures = failOnUnreadable(() => targetFeatureFailures(readCommittedModule()));
	const tools = ["clang", "lld", "llvm", "wasm-tools"].map((name) => installable(native, name));
	const output = nix([
		"shell",
		...tools,
		"--command",
		"bash",
		featureScript,
		...featureProbeArguments(featureTable),
	]).toString("utf8");
	return [
		...sectionFailures,
		...featureProbeFailures({
			sections: probeSections(output),
			table: featureTable,
			fixtures: featureFixtures(),
		}),
	];
}

/**
 * Builds the -g module, computes the roots that its build read, and scans
 * the committed module, the twin, and the -g module for them. The negative
 * fixture first proves that the scan finds each pattern.
 */
function hostPathStepFailures(native: System): readonly string[] {
	const debugPath = buildOutput(installable(native, "wasm-debug"), "mldsa-wasm-debug");
	const debugBytes = nix(["store", "cat", `${debugPath}/mldsa.debug.wasm`]);
	const buildFolder = nix(["store", "cat", `${debugPath}/build-folder`])
		.toString("utf8")
		.trim();
	const inputs = BuildRoots.parse(
		JSON.parse(
			nix([
				"eval",
				"--json",
				installable(native, "wasm-debug"),
				"--apply",
				"build: { inherit (build) MLDSA_NATIVE INCLUDE; }",
			]).toString("utf8"),
		),
	);
	const resourceFolder = nix([
		"shell",
		installable(native, "clang"),
		"--command",
		"clang",
		"-print-resource-dir",
	])
		.toString("utf8")
		.trim();
	const roots = [
		{ name: "the -g build's folder", path: buildFolder },
		{ name: "the vendored source", path: inputs.MLDSA_NATIVE },
		{ name: "the include folder", path: inputs.INCLUDE },
		{ name: "clang's resource folder", path: resourceFolder },
	];
	for (const { name, path } of roots) {
		console.log(`  ${name}: ${path}`);
	}
	const patterns = scanPatterns(roots);
	const twinBytes = readTwinBytes(native);
	const mapNames = prefixMapNames(readFileSync(join(root, buildScript), "utf8"));
	return [
		...negativeFixtureFailures(patterns),
		...failOnUnreadable(() => debugInfoFailures(readModule(debugBytes), mapNames), "the -g build"),
		...hostPathFailures(moduleFile, readFileSync(join(root, moduleFile)), patterns),
		...hostPathFailures("The unstripped twin", twinBytes, patterns),
		...hostPathFailures("The -g build", debugBytes, patterns),
	];
}

/** The tarball that the package build packed on `system`, relative to the repo root. */
function packedTarball(system: System): string {
	return `${packedFolder}/${packedTarballName(system)}`;
}

/**
 * The folder inside the container that the pack on `system` works in. Each
 * system gets its own, so a build that embeds the folder's path gives two
 * different tarballs, and the path scan finds the path.
 */
function packFolder(system: System): string {
	return `/tmp/ml-dsa-pack-${system}`;
}

/**
 * The repo files that the install and the pack may read: every file that git
 * tracks, as the working tree holds it, outside the vector folder and the
 * submodule, and upstream's license. As with the flake, a new file packs only
 * once git tracks it.
 */
function packInputs(): readonly string[] {
	const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
	if (listed.error !== undefined) {
		throw listed.error;
	}
	if (listed.status !== 0) {
		throw new CommandFailed(`\`git ls-files\` failed: ${listed.stderr}`);
	}
	const tracked = listed.stdout
		.split("\0")
		.filter(
			(file) =>
				file !== "" &&
				!file.startsWith("vectors/") &&
				file !== submodulePath &&
				existsSync(join(root, file)),
		);
	return [...tracked, `${submodulePath}/LICENSE`];
}

/** Packs the tarball inside the container on `build`'s system, and writes it to the packed folder. */
function packOn(build: Build): PackedTarball {
	const emulationFlags = build.emulated ? ["--option", "extra-platforms", build.system] : [];
	const bytes = nix([
		"shell",
		...emulationFlags,
		installable(build.system, "nodejs"),
		installable(build.system, "pnpm"),
		"--command",
		"bash",
		packScript,
		packFolder(build.system),
		...packInputs(),
	]);
	writeFileSync(join(root, packedTarball(build.system)), bytes);
	console.log(
		`  ${build.system} tarball (${build.emulated ? "emulated" : "native"}): ${sha256(bytes)}`,
	);
	return { system: build.system, bytes };
}

/**
 * Packs the tarball on each planned system and compares the tarballs. With
 * `nativeOnly`, it packs only the native one, and CI compares the tarballs of
 * its two runners in a later job.
 */
function packageBuildFailures(native: System, nativeOnly: boolean): readonly string[] {
	rmSync(join(root, packedFolder), { recursive: true, force: true });
	mkdirSync(join(root, packedFolder), { recursive: true });
	const [first, second] = plannedBuilds(native, nativeOnly).map(packOn);
	if (first === undefined || second === undefined) {
		return [];
	}
	const comparison = compareTarballs(first, second);
	if (!comparison.passed) {
		return comparison.failures;
	}
	console.log(`  ${comparison.summary}`);
	return [];
}

/** The store path that `nix build` prints for `target`. */
function storePath(target: string): string {
	const path = nix(["build", "--no-link", "--print-out-paths", target]).toString("utf8").trim();
	if (!/^\/nix\/store\/[0-9a-z]{32}-[^/\n]+$/.test(path)) {
		throw new CommandFailed(
			`\`nix build\` printed ${JSON.stringify(path)} instead of one store path.`,
		);
	}
	return path;
}

/** Runs the package checks on the native tarball, which the package build wrote. */
function packageCheckFailures(native: System): readonly string[] {
	const tarball = packedTarball(native);
	const bytes = readFileSync(join(root, tarball));
	let files: TarballFiles | undefined = undefined;
	try {
		files = readTarball(bytes);
	} catch (error) {
		if (error instanceof TarballFormatError) {
			return [`The check can't read ${tarball}. ${error.message}`];
		}
		throw error;
	}
	const roots = [
		{ name: "the pack's folder", path: packFolder(native) },
		{ name: "the repo", path: root },
		{ name: "the pack's Node.js", path: storePath(installable(native, "nodejs")) },
		{ name: "the pack's pnpm", path: storePath(installable(native, "pnpm")) },
	];
	const patterns = scanPatterns(roots);
	const repoFiles = new Map(
		[...copiedFiles.values()].map((file) => {
			const path = join(root, file);
			return [file, existsSync(path) ? readFileSync(path) : undefined] as const;
		}),
	);
	return [
		...negativeFixtureFailures(patterns),
		...packageFailures({
			files,
			tarballBytes: bytes.length,
			committedList: readIfPresent(tarballFilesFile),
			repoFiles,
			vectorHashes: manifestHashes(root),
			patterns,
		}),
		...attwFailures(join(root, "node_modules/.bin/attw"), join(root, tarball)),
	];
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
		{ name: "instruction counts", run: () => onNativeSystem(instructionCountStepFailures) },
		{ name: "target features", run: () => onNativeSystem(targetFeatureStepFailures) },
		{ name: "host paths", run: () => onNativeSystem(hostPathStepFailures) },
		{
			name: "package build",
			run: () => onNativeSystem((native) => packageBuildFailures(native, options.nativeOnly)),
		},
		{ name: "package checks", run: () => onNativeSystem(packageCheckFailures) },
		// The stack-margin test prints the wasm stack peak of every operation.
		{ name: "stack margin", run: () => testFileFailures(stackMarginTest) },
		// The vector test routes the ACVP and Wycheproof cases through the
		// committed module, and prints the count per path and the cases per
		// segment.
		{ name: "vectors", run: () => testFileFailures(vectorTest) },
	];
}
