// The segments of the paths that the routing table credits. The vector test
// prints the cases per segment. It fails if a segment's counts move, if a
// public segment has neither cases through public rows nor a named test
// outside the vectors, or if a named test is missing from its file.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A segment of the path that a call runs through the package. */
export type SegmentName =
	| "input checks"
	| "zero checks"
	| "key pair from the seed"
	| "public-key hash from the secret key"
	| "public-key hash from the public key"
	| "prefix with an empty context"
	| "prefix with a non-empty context"
	| "empty message"
	| "one-chunk message"
	| "multi-chunk message"
	| "deterministic variant"
	| "hedged signing"
	| "verification"
	| "output and wipe"
	| "secret key from the caller"
	| "message with no prefix"
	| "external mu";

/**
 * A test outside the vectors that runs a segment, named by its file in
 * `test/` and its title.
 */
export interface NamedTest {
	readonly file: string;
	readonly title: string;
}

/** How many vector cases a segment gets, through public rows and through test-only rows. */
export interface SegmentCount {
	readonly publicRows: number;
	readonly testOnlyRows: number;
}

/** The count of a segment that no case reaches. */
export const noCases: SegmentCount = Object.freeze({ publicRows: 0, testOnlyRows: 0 });

/** What the table records about one segment. */
export interface Segment {
	/**
	 * Whether the public API runs the segment. The others run only through the
	 * test-only entry point.
	 */
	readonly public: boolean;
	/** The tests outside the vectors that run the segment. */
	readonly tests: readonly NamedTest[];
	/**
	 * How many vector cases the segment gets. A vector update or a change to a
	 * row's segments changes it in the same commit.
	 */
	readonly cases: SegmentCount;
}

/** Every segment, in the order that the vector test prints them. */
export const segmentTable: Readonly<Record<SegmentName, Segment>> = {
	// The read step and the input checks of each byte input.
	"input checks": {
		public: true,
		tests: [],
		cases: { publicRows: 1056, testOnlyRows: 1090 },
	},
	"zero checks": {
		public: true,
		tests: [{ file: "zero-checks.test.ts", title: "accept every single-bit input" }],
		cases: { publicRows: 371, testOnlyRows: 30 },
	},
	"key pair from the seed": {
		public: true,
		tests: [],
		cases: { publicRows: 371, testOnlyRows: 252 },
	},
	"public-key hash from the secret key": {
		public: true,
		tests: [],
		cases: { publicRows: 293, testOnlyRows: 658 },
	},
	"public-key hash from the public key": {
		public: true,
		tests: [],
		cases: { publicRows: 640, testOnlyRows: 75 },
	},
	"prefix with an empty context": {
		public: true,
		tests: [],
		cases: { publicRows: 793, testOnlyRows: 216 },
	},
	"prefix with a non-empty context": {
		public: true,
		tests: [],
		cases: { publicRows: 140, testOnlyRows: 172 },
	},
	"empty message": {
		public: true,
		tests: [],
		cases: { publicRows: 18, testOnlyRows: 0 },
	},
	"one-chunk message": {
		public: true,
		tests: [],
		cases: { publicRows: 915, testOnlyRows: 703 },
	},
	// The longest vector message has 8,192 bytes, so no vector case reaches a
	// second chunk.
	"multi-chunk message": {
		public: true,
		tests: [
			{
				file: "message-path.test.ts",
				title: "of $objectName hashes the public-key hash, the prefix, and the message",
			},
			{ file: "differential.test.ts", title: "$objectName signs every case as noble does" },
		],
		cases: { publicRows: 0, testOnlyRows: 0 },
	},
	"deterministic variant": {
		public: true,
		tests: [],
		cases: { publicRows: 245, testOnlyRows: 634 },
	},
	"hedged signing": {
		public: true,
		tests: [],
		cases: { publicRows: 48, testOnlyRows: 363 },
	},
	verification: {
		public: true,
		tests: [],
		cases: { publicRows: 640, testOnlyRows: 120 },
	},
	"output and wipe": {
		public: true,
		tests: [{ file: "exit-matrix.test.ts", title: "the exit matrix" }],
		cases: { publicRows: 1011, testOnlyRows: 1087 },
	},
	"secret key from the caller": {
		public: false,
		tests: [],
		cases: { publicRows: 0, testOnlyRows: 997 },
	},
	"message with no prefix": {
		public: false,
		tests: [],
		cases: { publicRows: 0, testOnlyRows: 315 },
	},
	"external mu": {
		public: false,
		tests: [],
		cases: { publicRows: 0, testOnlyRows: 384 },
	},
};

/**
 * Checks a segment table against the cases that each segment got.
 *
 * @param counts The number of vector cases per segment, as `segmentCounts`
 * returns them. A segment that it lacks got none.
 * @returns One message per segment whose counts differ from the table's, per
 * public segment that has neither cases through public rows nor a named
 * test, and per named test that its file doesn't hold.
 */
export function segmentFailures(
	table: Readonly<Record<string, Segment>>,
	counts: ReadonlyMap<string, SegmentCount>,
): readonly string[] {
	const failures: string[] = [];
	for (const [name, segment] of Object.entries(table)) {
		const { publicRows, testOnlyRows } = counts.get(name) ?? noCases;
		if (publicRows !== segment.cases.publicRows || testOnlyRows !== segment.cases.testOnlyRows) {
			failures.push(
				`The segment "${name}" got ${publicRows} cases through public rows and ${testOnlyRows} through test-only rows, but the table pins ${segment.cases.publicRows} and ${segment.cases.testOnlyRows}.`,
			);
		}
		if (segment.public && segment.tests.length === 0 && publicRows === 0) {
			failures.push(
				`The public segment "${name}" has no vector cases through public rows and no named test.`,
			);
		}
		for (const { file, title } of segment.tests) {
			const text = readFileSync(join(import.meta.dirname, file), "utf8");
			if (!text.includes(`"${title}"`)) {
				failures.push(
					`The segment "${name}" names the test "${title}", which test/${file} doesn't hold.`,
				);
			}
		}
	}
	return failures;
}
