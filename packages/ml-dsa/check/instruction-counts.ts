/**
 * The instruction counts. The check decodes every function of the unstripped
 * twin, whose name section names the functions and whose code section must
 * equal the shipped module's. It counts each class in
 * {@link countedClasses} per function, and each nonzero count must equal its
 * entry in `expected-counts.ts`, which gives the count a reason of kind
 * `public` or `declassified`. A count and its reason change together.
 *
 * The check also fails on any `memory.grow`, for which no reason exists. A
 * `v128` instruction lies outside the MVP, so the decoder already rejects it.
 * Records 0001 and 0002 in docs/adr/ hold the reasons for the counts, and
 * record 0005 fixes the memory's size.
 */
import { fileLines } from "./snapshot.ts";
import {
	functionNames,
	type SectionContents,
	type WasmModule,
	WasmFormatError,
} from "./wasm-binary.ts";
import { decodeFunctionBodies, type Instruction } from "./wasm-code.ts";

/** The committed counts and reasons, relative to the repo root. */
export const expectedCountsFile = "packages/ml-dsa/check/expected-counts.ts";

/**
 * The export of the twin that holds the opt-blocker's address. The twin's
 * link in `build.sh` adds it, and the shipped module lacks it.
 */
export const optBlockerExport = "mldsa_ct_opt_blocker_u64";

/**
 * The classes that the check counts. `div and rem` holds the eight integer
 * divisions and remainders. `floating point` holds every instruction that
 * reads or writes an `f32` or an `f64`, `f32.div` and `f64.div` included. An
 * `opt-blocker load` is an `i64.load` whose address is a constant equal to
 * the opt-blocker's address, which is how the volatile barrier of record
 * 0002 reads it.
 */
export const countedClasses = [
	"if",
	"br_if",
	"br_table",
	"select",
	"div and rem",
	"clz",
	"ctz",
	"popcnt",
	"floating point",
	"call_indirect",
	"opt-blocker load",
] as const;

export type CountedClass = (typeof countedClasses)[number];

/** A line of upstream's source before which upstream declassifies a value. */
export interface DeclassifiedSite {
	/** The file, relative to the vendored source's root, such as `mldsa/src/sign.c`. */
	readonly file: string;
	/**
	 * The line that branches on the value or passes it on. Its code, outside
	 * comments, must name the value.
	 */
	readonly line: number;
	/** The value as `MLD_CT_TESTING_DECLASSIFY` names it, without a leading `&`. */
	readonly value: string;
}

/**
 * Why a nonzero count is safe. A `public` count depends only on values that
 * upstream's constant-time model treats as public, such as lengths, loop
 * counters, the public key, and the signature. A `declassified` count also
 * depends on a value that upstream declassifies with
 * `MLD_CT_TESTING_DECLASSIFY`, at each of its sites.
 */
export type Reason =
	| { readonly kind: "public"; readonly why: string }
	| {
			readonly kind: "declassified";
			readonly why: string;
			readonly sites: readonly DeclassifiedSite[];
	  };

/** One nonzero count of one class in one function, with its reason. */
export interface ExpectedCount {
	readonly function: string;
	readonly class: CountedClass;
	readonly count: number;
	readonly reason: Reason;
}

/** The counts of one function, without the classes that it holds none of. */
type Counts = ReadonlyMap<CountedClass, number>;

function classOf(
	instruction: Instruction,
	previous: Instruction | undefined,
	optBlocker: number,
): CountedClass | undefined {
	const { name } = instruction;
	switch (name) {
		case "if":
		case "br_if":
		case "br_table":
		case "select":
		case "call_indirect":
			return name;
		default:
	}
	if (/^i(?:32|64)\.(?:div|rem)_[su]$/.test(name)) {
		return "div and rem";
	}
	const bitCount = /^i(?:32|64)\.(clz|ctz|popcnt)$/.exec(name)?.[1];
	if (bitCount === "clz" || bitCount === "ctz" || bitCount === "popcnt") {
		return bitCount;
	}
	if (/(?:^|_)f(?:32|64)/.test(name)) {
		return "floating point";
	}
	if (name === "i64.load" && previous?.name === "i32.const") {
		const [base] = previous.immediates;
		const [, offset] = instruction.immediates;
		if (typeof base === "number" && typeof offset === "number") {
			// A wasm address is the unsigned base plus the offset.
			return (base >>> 0) + offset === optBlocker ? "opt-blocker load" : undefined;
		}
	}
	return undefined;
}

function countClasses(instructions: readonly Instruction[], optBlocker: number): Counts {
	const counts = new Map<CountedClass, number>();
	instructions.forEach((instruction, index) => {
		const counted = classOf(instruction, instructions[index - 1], optBlocker);
		if (counted !== undefined) {
			counts.set(counted, (counts.get(counted) ?? 0) + 1);
		}
	});
	return counts;
}

/**
 * The value of the global that a twin exports as {@link optBlockerExport}.
 *
 * @throws WasmFormatError if the twin doesn't export it.
 */
function optBlockerAddress(twin: WasmModule): number {
	const entry = twin.exports.find(
		(candidate) => candidate.name === optBlockerExport && candidate.kind === "global",
	);
	const imported = twin.imports.filter((item) => item.kind === "global").length;
	const address = entry === undefined ? undefined : twin.globals[entry.index - imported]?.i32Value;
	if (address === undefined) {
		throw new WasmFormatError(
			`The twin exports no global ${optBlockerExport}, which holds the opt-blocker's address. The twin's link in packages/ml-dsa/wasm/build.sh exports it.`,
		);
	}
	return address;
}

function sameBytes(left: SectionContents | undefined, right: SectionContents | undefined): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.bytes.length === right.bytes.length &&
		left.bytes.every((byte, index) => byte === right.bytes[index])
	);
}

/** A function of the twin, with its name from the name section. */
interface NamedBody {
	readonly name: string;
	readonly instructions: readonly Instruction[];
}

/**
 * Decodes the twin's functions in function order, each with its name.
 *
 * @throws WasmFormatError if the decoder can't read the code, or if the name section doesn't give each function a name of its own.
 */
function namedBodies(twin: WasmModule): readonly NamedBody[] {
	const names = functionNames(twin);
	const seen = new Set<string>();
	return decodeFunctionBodies(twin).map(({ index, instructions }) => {
		const name = names.get(index);
		if (name === undefined) {
			throw new WasmFormatError(`The name section doesn't name the function ${String(index)}.`);
		}
		if (seen.has(name)) {
			throw new WasmFormatError(
				`The name section names two functions ${name}, so the check can't tell their counts apart.`,
			);
		}
		seen.add(name);
		return { name, instructions };
	});
}

/** The nonzero counts of each function, keyed by its name, in function order. */
function functionCounts(
	bodies: readonly NamedBody[],
	optBlocker: number,
): ReadonlyMap<string, Counts> {
	return new Map(
		bodies.map(({ name, instructions }) => [name, countClasses(instructions, optBlocker)]),
	);
}

/**
 * The total of each class over the twin's functions, in the order of
 * {@link countedClasses}, without the classes that no function holds.
 *
 * @throws WasmFormatError if the decoder can't read the twin's code, or if the twin lacks the opt-blocker's export or a name of its own for each function.
 */
export function countTotals(twin: WasmModule): ReadonlyMap<CountedClass, number> {
	const counts = [...functionCounts(namedBodies(twin), optBlockerAddress(twin)).values()];
	const totals = new Map<CountedClass, number>();
	for (const counted of countedClasses) {
		const total = counts.reduce((sum, each) => sum + (each.get(counted) ?? 0), 0);
		if (total > 0) {
			totals.set(counted, total);
		}
	}
	return totals;
}

function memoryGrowFailures(bodies: readonly NamedBody[]): readonly string[] {
	return bodies.flatMap(({ name, instructions }) =>
		instructions
			.filter((instruction) => instruction.name === "memory.grow")
			.map(
				(instruction) =>
					`${name} holds memory.grow at byte ${String(instruction.offset)}. The module's memory never grows, so no reason can allow one.`,
			),
	);
}

function reasonFailures(entry: ExpectedCount): readonly string[] {
	const subject = `${entry.class} in ${entry.function} in ${expectedCountsFile}`;
	const failures: string[] = [];
	if (entry.reason.why.trim() === "") {
		failures.push(`The reason for ${subject} says nothing.`);
	}
	if (entry.reason.kind === "declassified" && entry.reason.sites.length === 0) {
		failures.push(`The declassified reason for ${subject} cites no upstream site.`);
	}
	return failures;
}

function comparisonFailures(
	counts: ReadonlyMap<string, Counts>,
	expected: readonly ExpectedCount[],
): readonly string[] {
	const failures: string[] = [];
	const listed = new Map<string, ExpectedCount>();
	for (const entry of expected) {
		const key = `${entry.function}\u0000${entry.class}`;
		if (listed.has(key)) {
			failures.push(`${expectedCountsFile} lists ${entry.class} in ${entry.function} twice.`);
		} else if (entry.count === 0) {
			failures.push(
				`${expectedCountsFile} lists 0 ${entry.class} in ${entry.function}. Only a nonzero count takes an entry.`,
			);
		}
		listed.set(key, entry);
	}

	for (const [name, functionClasses] of counts) {
		for (const [counted, count] of functionClasses) {
			const entry = listed.get(`${name}\u0000${counted}`);
			if (entry === undefined) {
				failures.push(
					`${name} holds ${String(count)} ${counted}, but ${expectedCountsFile} has no entry for it. Add the count with a reason of kind "public" or "declassified".`,
				);
			} else if (entry.count !== count) {
				failures.push(
					`${name} holds ${String(count)} ${counted}, but ${expectedCountsFile} lists ${String(entry.count)}. If the change is intended, review the reason, then change the count and the reason together.`,
				);
			}
		}
	}

	for (const entry of listed.values()) {
		const functionClasses = counts.get(entry.function);
		if (functionClasses === undefined) {
			failures.push(
				`${expectedCountsFile} lists ${String(entry.count)} ${entry.class} in ${entry.function}, but the twin has no function ${entry.function}.`,
			);
		} else if (entry.count !== 0 && !functionClasses.has(entry.class)) {
			failures.push(
				`${expectedCountsFile} lists ${String(entry.count)} ${entry.class} in ${entry.function}, but ${entry.function} holds none.`,
			);
		}
	}
	return failures;
}

/** What the instruction counts compare. */
export interface CountFacts {
	/** The committed module. */
	readonly shipped: WasmModule;
	/** The unstripped twin from the native build. */
	readonly twin: WasmModule;
	/** The committed counts and reasons. */
	readonly expected: readonly ExpectedCount[];
}

/**
 * Returns one message per rule of the instruction counts that the facts
 * break. The counts are compared only when the twin's code section equals
 * the shipped module's and no function holds `memory.grow`, because the
 * counts would otherwise describe other code.
 *
 * @throws WasmFormatError if the decoder can't read the twin's code, or if the twin lacks the opt-blocker's export or a name of its own for each function.
 */
export function instructionCountFailures(facts: CountFacts): readonly string[] {
	const bodies = namedBodies(facts.twin);
	const failures = [
		...(sameBytes(facts.shipped.code, facts.twin.code)
			? []
			: [
					"The unstripped twin's code section differs from the shipped module's, so its counts wouldn't describe the shipped code.",
				]),
		...memoryGrowFailures(bodies),
	];
	if (failures.length > 0) {
		return failures;
	}
	const counts = functionCounts(bodies, optBlockerAddress(facts.twin));
	return [...comparisonFailures(counts, facts.expected), ...facts.expected.flatMap(reasonFailures)];
}

function escapeRegExp(text: string): string {
	return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The code of one line of upstream's C, without its comments. In upstream's
 * style, a line inside a block comment starts with `*` and then a space, a
 * slash, or the line's end. A statement such as `*out = x;` is code.
 */
function codeOf(line: string): string {
	const text = line.trimStart();
	if (/^\*(?:\s|\/|$)/.test(text) || text.startsWith("/*") || text.startsWith("//")) {
		return "";
	}
	return line.replaceAll(/\/\*.*?\*\//g, "").replace(/\/\*.*$|\/\/.*$/, "");
}

/**
 * Whether `MLD_CT_TESTING_DECLASSIFY` declassifies `value` on a line before
 * `line`, within the same function and after the value's last assignment.
 * The search walks up from the line and reads only code, so a comment
 * neither assigns nor declassifies. It stops at an assignment to the value or
 * to an element or member of it, because a declassification above it covers
 * an older value. It also stops at a brace at column 0, which in upstream's
 * style opens or closes a function body. It can't see a function call that
 * writes the value through a pointer, so review covers that.
 */
function declassifiedBefore(lines: readonly string[], line: number, value: string): boolean {
	const name = escapeRegExp(value);
	const macro = new RegExp(`\\bMLD_CT_TESTING_DECLASSIFY\\(\\s*&?\\s*${name}\\s*,`);
	// The value, or an element or member of it, but not a member of something
	// else that has the value's name, written without spaces around `.` or
	// `->` as upstream's style writes it.
	const target = `(?<!\\.|->)\\b${name}(?:\\s*\\[[^\\]]*\\]|\\s*(?:\\.|->)\\s*\\w+)*`;
	// `=`, the compound assignments, and `++` and `--`, but not `==`.
	const assignment = new RegExp(
		`${target}\\s*(?:(?:[-+*/%&|^]|<<|>>)?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${target}`,
	);
	for (let index = line - 2; index >= 0; index -= 1) {
		const text = codeOf(lines[index] ?? "");
		if (text.startsWith("{") || text.startsWith("}")) {
			return false;
		}
		if (macro.test(text)) {
			return true;
		}
		if (assignment.test(text)) {
			return false;
		}
	}
	return false;
}

/**
 * Returns one message per site of a `declassified` reason that the vendored
 * source doesn't back. The cited line's code must name the value as a word,
 * and `MLD_CT_TESTING_DECLASSIFY` must declassify the value on an earlier
 * line of the same function, with no assignment to the value in between.
 * `readSource` returns a file of the vendored source by its path relative to
 * the source's root, or `undefined` if the file is missing.
 */
export function declassificationFailures(
	expected: readonly ExpectedCount[],
	readSource: (file: string) => string | undefined,
): readonly string[] {
	return expected.flatMap((entry) => {
		const { reason } = entry;
		if (reason.kind !== "declassified") {
			return [];
		}
		const subject = `The declassified reason for ${entry.class} in ${entry.function} in ${expectedCountsFile}`;
		return reason.sites.flatMap(({ file, line, value }) => {
			const source = readSource(file);
			if (source === undefined) {
				return [`${subject} cites ${file}, which the vendored source lacks.`];
			}
			const lines = fileLines(source);
			const text = lines[line - 1];
			const cited = `${subject} cites line ${String(line)} of ${file}`;
			if (text === undefined || line < 1) {
				return [`${cited}, which has ${String(lines.length)} lines.`];
			}
			if (!new RegExp(`\\b${escapeRegExp(value)}\\b`).test(codeOf(text))) {
				return [`${cited}, whose code doesn't name ${value}.`];
			}
			if (!declassifiedBefore(lines, line, value)) {
				return [
					`${cited}, but no MLD_CT_TESTING_DECLASSIFY of ${value} comes before that line in its function, after the value's last assignment.`,
				];
			}
			return [];
		});
	});
}
