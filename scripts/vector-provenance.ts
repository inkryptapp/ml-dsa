/**
 * Fetches each vector file from its URL in `vectors/manifest.json` and
 * compares the bytes with the committed file. It needs the network, so the
 * check command doesn't run it. Run it from the repo root after a vector
 * update:
 *
 *   node scripts/vector-provenance.ts
 */
import { root } from "./check-step.ts";
import { provenanceFailures } from "./vector-manifest.ts";

async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} answered ${String(response.status)} ${response.statusText}.`);
	}
	return new Uint8Array(await response.arrayBuffer());
}

const failures = await provenanceFailures(root, fetchBytes);
for (const failure of failures) {
	console.error(`FAIL ${failure}`);
}
if (failures.length > 0) {
	process.exit(1);
}
console.log("Every vector file equals the bytes that its URL serves.");
