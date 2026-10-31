/** The Linux systems that the flake builds the wasm module for. */
export const systems = ["aarch64-linux", "x86_64-linux"] as const;

export type System = (typeof systems)[number];

/** One build of the wasm module that the check command runs. */
export interface Build {
	readonly system: System;
	/** Whether arm64 Nix hands the build steps to the container host's x86_64 emulator. */
	readonly emulated: boolean;
}

/** A finished build: its store path and the SHA-256 of its module. */
export interface BuildResult extends Build {
	readonly storePath: string;
	readonly hash: string;
}

/** Returns the Linux system that the build container runs on a host of Node's `process.arch`, if the image has one. */
export function nativeSystem(arch: string): System | undefined {
	switch (arch) {
		case "arm64":
			return "aarch64-linux";
		case "x64":
			return "x86_64-linux";
		default:
			return undefined;
	}
}

/**
 * The native system always builds. An aarch64 host also builds x86_64 under
 * emulation unless `nativeOnly` is set. CI sets it, because its x86_64 runner
 * builds x86_64 natively.
 */
export function plannedBuilds(native: System, nativeOnly: boolean): readonly Build[] {
	const builds: Build[] = [{ system: native, emulated: false }];
	if (native === "aarch64-linux" && !nativeOnly) {
		builds.push({ system: "x86_64-linux", emulated: true });
	}
	return builds;
}

/**
 * Compares each build with the committed module at `file`. `committedHash` is
 * the module's SHA-256, or `undefined` when the file is missing. Returns one
 * message per build that differs, or one message when the module is missing.
 * A message about a build holds the command that copies that build into the
 * repo.
 */
export function rebuildFailures(
	file: string,
	committedHash: string | undefined,
	results: readonly BuildResult[],
): readonly string[] {
	const copy = (result: BuildResult): string =>
		`\`scripts/nix store cat ${result.storePath}/mldsa.wasm > ${file}\``;
	if (committedHash === undefined) {
		const native = results.find((result) => !result.emulated);
		return native === undefined
			? [`The repo has no ${file}.`]
			: [
					`The repo has no ${file}. Copy the ${native.system} build into the repo with ${copy(native)}, run the check again, and commit the module once every build equals it.`,
				];
	}
	return results
		.filter((result) => result.hash !== committedHash)
		.map(
			(result) =>
				`The ${result.system} build differs from ${file}. If you changed the build on purpose, copy the build into the repo with ${copy(result)} and run the check again. Otherwise the build isn't reproducible.`,
		);
}
