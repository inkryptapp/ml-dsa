/**
 * The check command, which `scripts/check` runs. The pin guard runs first, so
 * no build starts from a source that isn't the pin.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { wasmSteps } from "../packages/ml-dsa/check/steps.ts";
import { CommandFailed, nix, root, type Step } from "./check-step.ts";
import { pinGuardFailures, readPinState } from "./pin-guard.ts";
import { vectorFailures } from "./vector-manifest.ts";

const BrokenCases = z.array(z.string());

/** Runs the tests of the flake's rules in `nix/tests.nix`, which evaluate to the names of the cases that broke. */
function flakeRuleFailures(): readonly string[] {
	const broken = BrokenCases.parse(
		JSON.parse(nix(["eval", "--json", "--file", "nix/tests.nix"]).toString("utf8")),
	);
	return broken.map((name) => `The case "${name}" in nix/tests.nix broke.`);
}

function runStep(step: Step): readonly string[] {
	try {
		return step.run();
	} catch (error) {
		if (error instanceof CommandFailed) {
			return [error.message];
		}
		throw error;
	}
}

const { values } = parseArgs({
	options: { "native-only": { type: "boolean", default: false } },
	strict: true,
});

const steps: readonly Step[] = [
	{ name: "pin guard", run: () => pinGuardFailures(readPinState(root)) },
	{ name: "vector manifest", run: () => vectorFailures(root) },
	{ name: "flake rules", run: flakeRuleFailures },
	...wasmSteps({ nativeOnly: values["native-only"] }),
];

for (const step of steps) {
	console.log(`==> ${step.name}`);
	const failures = runStep(step);
	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`  FAIL ${failure}`);
		}
		console.error(`The check failed at the step "${step.name}".`);
		process.exit(1);
	}
}
console.log("Every check passed.");
