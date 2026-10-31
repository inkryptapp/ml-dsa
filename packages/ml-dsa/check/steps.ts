import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CommandFailed, nix, root, type Step } from "../../../scripts/check-step.ts";
import { buildScriptFailures, derivationFailures } from "./build-lint.ts";
import {
	nativeSystem,
	plannedBuilds,
	rebuildFailures,
	systems,
	type Build,
	type BuildResult,
	type System,
} from "./rebuild.ts";

const buildScript = "packages/ml-dsa/wasm/build.sh";
const committedModule = "packages/ml-dsa/wasm/mldsa.wasm";

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

function moduleRebuildFailures(nativeOnly: boolean): readonly string[] {
	const native = nativeSystem(process.arch);
	if (native === undefined) {
		return [`The build image runs only on arm64 and x86_64 hosts, not on ${process.arch}.`];
	}
	const path = join(root, committedModule);
	const committedHash = existsSync(path) ? sha256(readFileSync(path)) : undefined;
	console.log(`  ${committedModule}: ${committedHash ?? "missing"}`);
	const results = plannedBuilds(native, nativeOnly).map(buildModule);
	return rebuildFailures(committedModule, committedHash, results);
}

/** The wasm port's steps of the check command, in order. */
export function wasmSteps(options: { readonly nativeOnly: boolean }): readonly Step[] {
	return [
		{ name: "build lint", run: buildLintFailures },
		{ name: "wasm module rebuilds", run: () => moduleRebuildFailures(options.nativeOnly) },
	];
}
