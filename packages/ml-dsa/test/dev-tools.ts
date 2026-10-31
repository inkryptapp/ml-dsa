import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { join } from "node:path";

/** The repo root, which every path in the tests is relative to. */
export const root: string = join(import.meta.dirname, "../../..");

/**
 * The time limit in milliseconds for a test that runs a dev tool. Each run
 * starts new processes, so the limit sits well above Vitest's 5-second default
 * to leave room for a slow CI runner.
 */
export const toolTimeout = 60_000;

function run(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
	return spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...env, NO_COLOR: "1" },
	});
}

/** Runs a dev tool from the workspace's `node_modules/.bin` in the repo root. */
export function runTool(
	tool: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return run(join("node_modules/.bin", tool), args, env);
}

/** Runs a script from the root `package.json` through pnpm, with pnpm's own output silenced. */
export function runScript(
	script: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
	return run("pnpm", ["--silent", "run", script, ...args], env);
}
