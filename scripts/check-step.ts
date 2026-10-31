import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The repo root, which every path in the check command is relative to. */
export const root: string = join(import.meta.dirname, "..");

/** One step of the check command. It returns one message per failure, each saying what failed and why. */
export interface Step {
	readonly name: string;
	readonly run: () => readonly string[];
}

/** A command that a step ran failed or printed something unexpected. The check command reports the message as the step's failure. */
export class CommandFailed extends Error {}

/**
 * Runs `scripts/nix` with `args` in the repo root, and returns its standard
 * output. Its standard error goes to the terminal.
 */
export function nix(args: readonly string[]): Buffer {
	const result = spawnSync(join(root, "scripts/nix"), args, {
		cwd: root,
		stdio: ["ignore", "pipe", "inherit"],
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new CommandFailed(
			`\`scripts/nix ${args.join(" ")}\` failed with ${result.signal ?? `status ${String(result.status)}`}. Its output above says why.`,
		);
	}
	return result.stdout;
}
