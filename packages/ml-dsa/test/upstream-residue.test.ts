import { afterEach, describe, expect, test } from "vite-plus/test";

import type { FunctionName } from "../src/module-exports.js";
import { layout, setExportHook } from "../src/testing.js";
import { byteSource, firstDifference, parameterSetCases, seedFrom } from "./helpers.js";

afterEach(() => {
	setExportHook(null);
});

const rounds = 20;

/** The wasm stack right after one raw export returned. */
interface Snapshot {
	readonly name: FunctionName;
	readonly stack: Uint8Array;
}

for (const { objectName, object } of parameterSetCases) {
	describe(`upstream's residue in ${objectName}`, () => {
		test(`keygen and sign leave the same wasm stack after each export call in ${rounds} seeded rounds`, () => {
			const snapshotsOf = (round: number): readonly Snapshot[] => {
				const bytes = byteSource(0x5eed_0090 + round);
				const seed = seedFrom(200 + round);
				const snapshots: Snapshot[] = [];
				setExportHook((call) => {
					const result = call.proceed();
					snapshots.push({
						name: call.name,
						stack: call.memory.slice(layout.stack.start, layout.stack.end),
					});
					return result;
				});
				try {
					object.keygen(seed);
					object.sign({ seed, message: bytes(100), randomness: bytes(32) });
				} finally {
					setExportHook(null);
				}
				return snapshots;
			};
			const [first = [], ...later] = Array.from({ length: rounds }, (_, round) =>
				snapshotsOf(round),
			);

			const names = (snapshots: readonly Snapshot[]): readonly string[] =>
				snapshots.map(({ name }) => name);
			const differences = later.flatMap((snapshots, index) => {
				if (JSON.stringify(names(snapshots)) !== JSON.stringify(names(first))) {
					return [`Round ${index + 1} made other export calls than round 0.`];
				}
				return snapshots.flatMap(({ name, stack }, point) => {
					const offset = firstDifference(stack, first[point]?.stack ?? new Uint8Array(0));
					return offset === null
						? []
						: [`Round ${index + 1}, after ${name}: the wasm stack differs at offset ${offset}.`];
				});
			});
			expect(first.length).toBeGreaterThan(1);
			expect(differences).toStrictEqual([]);
		});
	});
}
