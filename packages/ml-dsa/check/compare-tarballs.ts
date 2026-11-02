/**
 * Compares the tarballs that CI's two runners packed. On CI, the check
 * command packs only the runner's own system, so a later job collects both
 * tarballs in one folder and compares them with the comparison that a local
 * check runs:
 *
 *   node packages/ml-dsa/check/compare-tarballs.ts FOLDER
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { systems, type System } from "./rebuild.ts";
import { compareTarballs, packedTarballName, type PackedTarball } from "./tarball.ts";

const { positionals } = parseArgs({ allowPositionals: true, strict: true });
const [folder] = positionals;
if (positionals.length !== 1 || folder === undefined) {
	console.error("Usage: node packages/ml-dsa/check/compare-tarballs.ts FOLDER");
	process.exit(2);
}

function packed(from: string, system: System): PackedTarball {
	return { system, bytes: readFileSync(join(from, packedTarballName(system))) };
}

const [firstSystem, secondSystem] = systems;
const first = packed(folder, firstSystem);
const second = packed(folder, secondSystem);
const comparison = compareTarballs(first, second);
if (!comparison.passed) {
	for (const failure of comparison.failures) {
		console.error(`  FAIL ${failure}`);
	}
	process.exit(1);
}
console.log(comparison.summary);
