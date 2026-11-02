import { describe, expect, test } from "vite-plus/test";

import {
	countTotals,
	declassificationFailures,
	expectedCountsFile,
	instructionCountFailures,
	optBlockerExport,
	type DeclassifiedSite,
	type ExpectedCount,
} from "./instruction-counts.ts";
import { readModule, type WasmModule } from "./wasm-binary.ts";
import {
	functionNameSection,
	functionType,
	name,
	s32,
	section,
	u32,
	valueType,
	vector,
	wasmModule,
} from "./wasm-fixtures.ts";

const { i32 } = valueType;
const optBlocker = 1024;

/** `i32.const value` */
const i32Const = (value: number): number[] => [0x41, ...s32(value)];
/** `i64.load` with the alignment 3 and `offset`. */
const i64Load = (offset: number): number[] => [0x29, 0x03, ...u32(offset)];

/** Joins a body's instructions, each given as its bytes. */
const join = (...instructions: readonly (readonly number[])[]): readonly number[] =>
	instructions.flat();

const localGet0 = [0x20, 0x00];
const drop = [0x1a];

// The bodies of the fixture's two functions, each without its closing `end`.

/** A loop with two br_if, then one select. */
const loopBody = join(
	[0x03, 0x40],
	localGet0,
	[0x0d, 0x00],
	localGet0,
	[0x0d, 0x00],
	[0x0b],
	localGet0,
	localGet0,
	localGet0,
	[0x1b],
	drop,
);

/**
 * A division, a float addition, and five 64-bit loads. Three read the
 * opt-blocker's address: as an offset, as the constant, and as their sum.
 * The fourth reads another address, and the fifth a computed one.
 */
const barrierBody = join(
	localGet0,
	localGet0,
	[0x6e],
	drop,
	[0x43, 0x00, 0x00, 0x00, 0x00],
	[0x43, 0x00, 0x00, 0x00, 0x00],
	[0x92],
	drop,
	i32Const(0),
	i64Load(optBlocker),
	drop,
	i32Const(optBlocker),
	i64Load(0),
	drop,
	i32Const(optBlocker - 8),
	i64Load(8),
	drop,
	i32Const(0),
	i64Load(optBlocker + 8),
	drop,
	localGet0,
	i64Load(optBlocker),
	drop,
);

function codeSection(functionBodies: readonly (readonly number[])[]): number[] {
	return section(
		10,
		vector(
			functionBodies.map((body) => {
				const contents = [...vector([[0x01, i32]]), ...body, 0x0b];
				return [...u32(contents.length), ...contents];
			}),
		),
	);
}

/**
 * The shipped module and its twin. The twin adds the name section and the
 * opt-blocker's export, unless `options` leaves them out or changes its code.
 */
function modules(
	options: {
		readonly twinBodies?: readonly (readonly number[])[];
		readonly names?: readonly string[];
		readonly exportOptBlocker?: boolean;
	} = {},
): { readonly shipped: WasmModule; readonly twin: WasmModule } {
	const shippedBodies = [loopBody, barrierBody];
	const head = [
		section(1, vector([functionType([i32], [])])),
		section(3, vector(shippedBodies.map(() => u32(0)))),
		section(6, vector([[i32, 0x00, ...i32Const(optBlocker), 0x0b]])),
	];
	const exports =
		(options.exportOptBlocker ?? true)
			? [section(7, vector([[...name(optBlockerExport), 0x03, 0x00]]))]
			: [];
	return {
		shipped: readModule(wasmModule(...head, codeSection(shippedBodies))),
		twin: readModule(
			wasmModule(
				...head,
				...exports,
				codeSection(options.twinBodies ?? shippedBodies),
				functionNameSection(options.names ?? ["loop", "barrier"]),
			),
		),
	};
}

const reason = { kind: "public", why: "The fixture's test." } as const;

const loopBranches = { function: "loop", class: "br_if", count: 2, reason } as const;
const loopSelect = { function: "loop", class: "select", count: 1, reason } as const;

const matching: readonly ExpectedCount[] = [
	loopBranches,
	loopSelect,
	{ function: "barrier", class: "div and rem", count: 1, reason },
	{ function: "barrier", class: "floating point", count: 3, reason },
	{ function: "barrier", class: "opt-blocker load", count: 3, reason },
];

describe("instructionCountFailures", () => {
	test("passes when each nonzero count of the twin equals its entry", () => {
		expect(instructionCountFailures({ ...modules(), expected: matching })).toStrictEqual([]);
	});

	test("totals each class over every function", () => {
		expect(countTotals(modules().twin)).toStrictEqual(
			new Map([
				["br_if", 2],
				["select", 1],
				["div and rem", 1],
				["floating point", 3],
				["opt-blocker load", 3],
			]),
		);
	});

	test("fails on a count that differs, a count without an entry, and an entry without a count", () => {
		const expected: readonly ExpectedCount[] = [
			{ function: "loop", class: "br_if", count: 3, reason },
			{ function: "barrier", class: "div and rem", count: 1, reason },
			{ function: "barrier", class: "floating point", count: 3, reason },
			{ function: "barrier", class: "opt-blocker load", count: 3, reason },
			{ function: "barrier", class: "br_table", count: 1, reason },
			{ function: "gone", class: "if", count: 1, reason },
		];
		expect(instructionCountFailures({ ...modules(), expected })).toStrictEqual([
			`loop holds 2 br_if, but ${expectedCountsFile} lists 3. If the change is intended, review the reason, then change the count and the reason together.`,
			`loop holds 1 select, but ${expectedCountsFile} has no entry for it. Add the count with a reason of kind "public" or "declassified".`,
			`${expectedCountsFile} lists 1 br_table in barrier, but barrier holds none.`,
			`${expectedCountsFile} lists 1 if in gone, but the twin has no function gone.`,
		]);
	});

	test("fails on an entry listed twice and on an entry with the count 0", () => {
		const expected: readonly ExpectedCount[] = [
			...matching,
			{ function: "loop", class: "select", count: 1, reason },
			{ function: "loop", class: "if", count: 0, reason },
		];
		expect(instructionCountFailures({ ...modules(), expected })).toStrictEqual([
			`${expectedCountsFile} lists select in loop twice.`,
			`${expectedCountsFile} lists 0 if in loop. Only a nonzero count takes an entry.`,
		]);
	});

	test("fails on a reason without text and a declassified reason without a site", () => {
		const expected: readonly ExpectedCount[] = [
			{ ...loopBranches, reason: { kind: "public", why: " " } },
			{ ...loopSelect, reason: { kind: "declassified", why: "A test.", sites: [] } },
			...matching.slice(2),
		];
		expect(instructionCountFailures({ ...modules(), expected })).toStrictEqual([
			`The reason for br_if in loop in ${expectedCountsFile} says nothing.`,
			`The declassified reason for select in loop in ${expectedCountsFile} cites no upstream site.`,
		]);
	});

	test("fails on any memory.grow, which no entry can allow", () => {
		const grow = [...i32Const(1), 0x40, 0x00, 0x1a];
		const { shipped, twin } = modules({ twinBodies: [grow, barrierBody] });
		const failures = instructionCountFailures({ shipped, twin, expected: matching });
		expect(failures).toContain(
			"loop holds memory.grow at byte 68. The module's memory never grows, so no reason can allow one.",
		);
	});

	test("fails when the twin's code section differs from the shipped module's", () => {
		const twinBodies = [loopBody, [...barrierBody, 0x01]];
		expect(
			instructionCountFailures({ ...modules({ twinBodies }), expected: matching }),
		).toStrictEqual([
			"The unstripped twin's code section differs from the shipped module's, so its counts wouldn't describe the shipped code.",
		]);
	});

	test("throws when the twin doesn't export the opt-blocker or doesn't name each function once", () => {
		expect(() =>
			instructionCountFailures({ ...modules({ exportOptBlocker: false }), expected: matching }),
		).toThrow(
			`The twin exports no global ${optBlockerExport}, which holds the opt-blocker's address. The twin's link in packages/ml-dsa/wasm/build.sh exports it.`,
		);
		expect(() =>
			instructionCountFailures({ ...modules({ names: ["loop"] }), expected: matching }),
		).toThrow("The name section doesn't name the function 1.");
		// Two functions of one name would share one entry, and the counts of
		// the first would go unchecked.
		expect(() =>
			instructionCountFailures({ ...modules({ names: ["loop", "loop"] }), expected: matching }),
		).toThrow(
			"The name section names two functions loop, so the check can't tell their counts apart.",
		);
		expect(() => countTotals(modules({ names: ["loop", "loop"] }).twin)).toThrow(
			"The name section names two functions loop",
		);
	});
});

describe("declassificationFailures", () => {
	const source = [
		"static int reject(uint32_t *z)",
		"{",
		"  uint32_t z_invalid = mld_poly_chknorm(z, B);",
		"  /* Constant time: it is fine to leak the norm check. */",
		"  MLD_CT_TESTING_DECLASSIFY(&z_invalid, sizeof(uint32_t));",
		"  if (z_invalid)",
		"  {",
		"    return 1;",
		"  }",
		"  MLD_CT_TESTING_DECLASSIFY(rho, MLDSA_SEEDBYTES);",
		"  return 0;",
		"}",
		"",
		"static int again(uint32_t *z)",
		"{",
		"  uint32_t t_valid = z[0] < 15;",
		"  MLD_CT_TESTING_DECLASSIFY(&t_valid, sizeof(int));",
		"  if (t_valid == 1 || t_valid != 2)",
		"  t_valid = z[1] < 15;",
		"  t_valid |= z[2] < 15;",
		"  return (int)t_valid;",
		"}",
		"",
		"static int commented(uint32_t *z)",
		"{",
		"  uint32_t h_invalid = z[0] < 15;",
		"  MLD_CT_TESTING_DECLASSIFY(&h_invalid, sizeof(int));",
		"  /* A note that reads h_invalid = 0, and",
		"   * h_invalid = 1 on the next line. */",
		"  if (h_invalid) /* h_invalid = 2 */",
		"  {",
		"    return 1;",
		"  }",
		"  h_invalid = z[1] < 15;",
		"  /* MLD_CT_TESTING_DECLASSIFY(&h_invalid, sizeof(int)); */",
		"  // MLD_CT_TESTING_DECLASSIFY(&h_invalid, sizeof(int));",
		"  return (int)h_invalid;",
		"}",
		"",
		"static int other(void)",
		"{",
		"  if (z_invalid)",
		"  {",
		"    return 1;",
		"  }",
		"  return 0;",
		"}",
		"",
	].join("\n");
	const pointerSource = [
		"static void send(uint8_t *out, uint8_t x)",
		"{",
		"  MLD_CT_TESTING_DECLASSIFY(out, 1);",
		"  *out = x;",
		"  forward(out);",
		"}",
		"",
		"static void fill(mld_poly *w0, uint8_t *rho, struct s *state)",
		"{",
		"  MLD_CT_TESTING_DECLASSIFY(w0, sizeof(*w0));",
		"  MLD_CT_TESTING_DECLASSIFY(rho, 32);",
		"  state->rho = 2;",
		"  if (rho[0] == 1 && w0->vec[0].coeffs[0] <= 2)",
		"  pack(w0, rho);",
		"  w0->vec[1].coeffs[2] = 7;",
		"  rho[0] += 1;",
		"  pack(w0, rho);",
		"}",
		"",
		"static void step(uint8_t *pos, uint8_t *ctr)",
		"{",
		"  MLD_CT_TESTING_DECLASSIFY(pos, 1);",
		"  MLD_CT_TESTING_DECLASSIFY(ctr, 1);",
		"  pos++;",
		"  --ctr;",
		"  next(pos, ctr);",
		"}",
		"",
	].join("\n");
	const files: Readonly<Record<string, string>> = {
		"mldsa/src/sign.c": source,
		"mldsa/src/poly.c": pointerSource,
	};
	const readSource = (file: string): string | undefined => files[file];

	const entry = (...sites: readonly DeclassifiedSite[]): ExpectedCount => ({
		function: "mldsa44_signature_internal",
		class: "br_if",
		count: 1,
		reason: { kind: "declassified", why: "The norm check.", sites },
	});
	const subject = `The declassified reason for br_if in mldsa44_signature_internal in ${expectedCountsFile}`;

	test("passes when the function declassifies the value before the cited line, which names it", () => {
		expect(
			declassificationFailures(
				[entry({ file: "mldsa/src/sign.c", line: 6, value: "z_invalid" })],
				readSource,
			),
		).toStrictEqual([]);
	});

	test("ignores public reasons", () => {
		expect(
			declassificationFailures(
				[{ function: "f", class: "if", count: 1, reason: { kind: "public", why: "A test." } }],
				readSource,
			),
		).toStrictEqual([]);
	});

	test("fails when the declassification comes after the line or in another function", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/sign.c", line: 3, value: "z_invalid" },
						{ file: "mldsa/src/sign.c", line: 42, value: "z_invalid" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 3 of mldsa/src/sign.c, but no MLD_CT_TESTING_DECLASSIFY of z_invalid comes before that line in its function, after the value's last assignment.`,
			`${subject} cites line 42 of mldsa/src/sign.c, but no MLD_CT_TESTING_DECLASSIFY of z_invalid comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("fails when the value is assigned again after its declassification", () => {
		expect(
			declassificationFailures(
				[
					entry(
						// A comparison above the line isn't an assignment.
						{ file: "mldsa/src/sign.c", line: 19, value: "t_valid" },
						{ file: "mldsa/src/sign.c", line: 20, value: "t_valid" },
						{ file: "mldsa/src/sign.c", line: 21, value: "t_valid" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 20 of mldsa/src/sign.c, but no MLD_CT_TESTING_DECLASSIFY of t_valid comes before that line in its function, after the value's last assignment.`,
			`${subject} cites line 21 of mldsa/src/sign.c, but no MLD_CT_TESTING_DECLASSIFY of t_valid comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("reads code only, so a comment neither assigns the value nor declassifies it", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/sign.c", line: 30, value: "h_invalid" },
						{ file: "mldsa/src/sign.c", line: 37, value: "h_invalid" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 37 of mldsa/src/sign.c, but no MLD_CT_TESTING_DECLASSIFY of h_invalid comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("fails on a cited line that names the value only in a comment", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/sign.c", line: 28, value: "h_invalid" },
						{ file: "mldsa/src/sign.c", line: 29, value: "h_invalid" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 28 of mldsa/src/sign.c, whose code doesn't name h_invalid.`,
			`${subject} cites line 29 of mldsa/src/sign.c, whose code doesn't name h_invalid.`,
		]);
	});

	test("reads a statement that starts with a dereference as code", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/poly.c", line: 4, value: "out" },
						{ file: "mldsa/src/poly.c", line: 5, value: "out" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 5 of mldsa/src/poly.c, but no MLD_CT_TESTING_DECLASSIFY of out comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("reads a write to an element or a member as an assignment, but not a comparison", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/poly.c", line: 14, value: "w0" },
						{ file: "mldsa/src/poly.c", line: 14, value: "rho" },
						{ file: "mldsa/src/poly.c", line: 17, value: "w0" },
						{ file: "mldsa/src/poly.c", line: 17, value: "rho" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 17 of mldsa/src/poly.c, but no MLD_CT_TESTING_DECLASSIFY of w0 comes before that line in its function, after the value's last assignment.`,
			`${subject} cites line 17 of mldsa/src/poly.c, but no MLD_CT_TESTING_DECLASSIFY of rho comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("reads an increment or a decrement as an assignment", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/poly.c", line: 26, value: "pos" },
						{ file: "mldsa/src/poly.c", line: 26, value: "ctr" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 26 of mldsa/src/poly.c, but no MLD_CT_TESTING_DECLASSIFY of pos comes before that line in its function, after the value's last assignment.`,
			`${subject} cites line 26 of mldsa/src/poly.c, but no MLD_CT_TESTING_DECLASSIFY of ctr comes before that line in its function, after the value's last assignment.`,
		]);
	});

	test("fails when the cited line doesn't name the value as a word", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/sign.c", line: 8, value: "z_invalid" },
						{ file: "mldsa/src/sign.c", line: 6, value: "z" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites line 8 of mldsa/src/sign.c, whose code doesn't name z_invalid.`,
			`${subject} cites line 6 of mldsa/src/sign.c, whose code doesn't name z.`,
		]);
	});

	test("fails on a file that the vendored source lacks and a line past the end", () => {
		expect(
			declassificationFailures(
				[
					entry(
						{ file: "mldsa/src/gone.c", line: 1, value: "rho" },
						{ file: "mldsa/src/sign.c", line: 60, value: "rho" },
					),
				],
				readSource,
			),
		).toStrictEqual([
			`${subject} cites mldsa/src/gone.c, which the vendored source lacks.`,
			`${subject} cites line 60 of mldsa/src/sign.c, which has 47 lines.`,
		]);
	});
});
