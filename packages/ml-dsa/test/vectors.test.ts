import { describe, expect, test } from "vite-plus/test";

import { readVerifiedVectors } from "../../../scripts/vector-manifest.js";
import { root } from "./dev-tools.js";
import { freshMemoryMismatch, messageOf } from "./helpers.js";
import {
	countFailures,
	paths,
	route,
	routingTable,
	routingTableVersion,
	segmentCounts,
	shapeFailures,
	type Row,
} from "./routing-table.js";
import { noCases, segmentFailures, segmentTable, type SegmentCount } from "./segment-table.js";
import { readCases, type VectorCase } from "./vector-cases.js";

// The read throws unless every vector file matches the manifest, so a file
// that doesn't match fails this whole file before any case is routed.
const cases = readCases(readVerifiedVectors(root));
const routing = route(cases, routingTable);

// A row runs up to hundreds of signatures, some through many rounds of the
// signing loop, so it gets a longer limit than Vitest's 5-second default.
const rowTimeout = 60_000;

function casesOf(row: Row): readonly VectorCase[] {
	return routing.cases.get(row) ?? [];
}

/** A number padded to one column of the printed tables. */
function column(value: number): string {
	return String(value).padStart(5);
}

function countReport(): string {
	const lines = [`Routing table version ${routingTableVersion}`];
	for (const source of ["ACVP", "Wycheproof"]) {
		lines.push(`${source} cases by path:`);
		for (const path of paths) {
			const total = routingTable
				.filter((row) => row.path === path)
				.flatMap(casesOf)
				.filter((vector) => vector.suite.startsWith(source)).length;
			lines.push(`  ${column(total)}  ${path}`);
		}
	}
	lines.push("Cases by row:");
	for (const row of routingTable) {
		lines.push(`  ${column(casesOf(row).length)}  ${row.path.padEnd(13)}  ${row.name}`);
	}
	return lines.join("\n");
}

function segmentReport(counts: ReadonlyMap<string, SegmentCount>): string {
	const lines = ["Vector cases by segment, through public rows and through test-only rows:"];
	for (const [name, segment] of Object.entries(segmentTable)) {
		const { publicRows, testOnlyRows } = counts.get(name) ?? noCases;
		const notes = [
			...(segment.public ? [] : ["test-only segment"]),
			...segment.tests.map(({ file }) => `also test/${file}`),
		];
		lines.push(
			`  ${name.padEnd(36)}${column(publicRows)}${column(testOnlyRows)}${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`,
		);
	}
	return lines.join("\n");
}

describe("the ACVP and Wycheproof vectors", () => {
	test("each match exactly one row of the routing table", () => {
		expect(routing.failures).toStrictEqual([]);
	});

	test("have the field shapes that their flags and groups imply", () => {
		expect(shapeFailures(cases)).toStrictEqual([]);
	});

	test(`give each row of routing table version ${routingTableVersion} its pinned count`, () => {
		console.info(countReport());
		expect(countFailures(routing)).toStrictEqual([]);
	});

	for (const row of routingTable) {
		const { run } = row;
		if (run === undefined) {
			continue;
		}
		test(
			`give their expected results through the row "${row.name}"`,
			() => {
				const failures: string[] = [];
				for (const vector of casesOf(row)) {
					try {
						run(vector);
					} catch (error) {
						failures.push(`${vector.label}: ${messageOf(error)}`);
					}
				}
				expect(failures).toStrictEqual([]);
				expect(freshMemoryMismatch()).toBeNull();
			},
			rowTimeout,
		);
	}

	test("give each segment its pinned counts, and every public segment a backing", () => {
		const counts = segmentCounts(routing);
		console.info(segmentReport(counts));
		expect(segmentFailures(segmentTable, counts)).toStrictEqual([]);
	});
});
