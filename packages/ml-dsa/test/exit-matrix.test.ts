import { describe, expect, test } from "vite-plus/test";

import { rowMismatches } from "./exit-matrix.js";
import { generatedRows, listedRows, rowName, type Row } from "./exit-rows.js";

const rows: readonly (readonly [string, Row])[] = [...generatedRows(), ...listedRows()].map(
	(row) => [rowName(row), row],
);

describe("the exit matrix", () => {
	for (const recording of [false, true]) {
		describe(`with recording ${recording ? "on" : "off"}`, () => {
			test.each(rows)("%s", (_, row) => {
				expect(rowMismatches(row, recording)).toStrictEqual([]);
			});
		});
	}
});
