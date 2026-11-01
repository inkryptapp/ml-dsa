/**
 * Reads the CT matrix from upstream's `.github/workflows/ct-tests.yml`: each
 * entry of a job's `nix-shell` matrix list, and the `-O` levels that the
 * job's CT test steps run for it, each with the steps' `-D` definitions. It
 * also reads the definitions that upstream's CT action adds to every step. It
 * takes the files' text, so a caller can read them at any commit.
 *
 * Only the `nix-shell` list names the compilers, so a compiler that a comment
 * or a step condition names doesn't count. A step condition decides only
 * which `-O` levels an entry runs. A step credits its `-O` level only when its
 * `cflags` hold exactly one `-O` flag and otherwise only `-D` definitions. A
 * step that adds another flag, such as `-ffast-math`, doesn't test the level
 * as the build compiles it. The reader evaluates the step conditions that
 * compare `matrix.nix-shell` with string literals through `==`, `!=`, `&&`,
 * `||`, and parentheses. A job whose own condition is `false` doesn't count.
 * Any other condition, a matrix with `include` or `exclude`, or a file of
 * another shape throws a {@link CtMatrixError}, so a change to the file's
 * format fails until someone reviews it.
 */
import { parse } from "yaml";
import { z } from "zod";

/** The workflow, relative to the root of upstream's repository. */
export const ctWorkflowPath = ".github/workflows/ct-tests.yml";

/** The local action that builds upstream with a step's `cflags` and runs the CT tests. */
const ctActionFolder = ".github/actions/ct-test";

/** The CT action's file, relative to the root of upstream's repository. */
export const ctActionPath = `${ctActionFolder}/action.yml`;

/** The `-D` definitions of each CT step that tests one level, each set once. */
export type DefinitionSets = readonly (readonly string[])[];

/**
 * The CT matrix: each `nix-shell` entry with the `-O` levels that the CT tests
 * run for it, each with the definitions of the steps that run it.
 */
export type CtMatrix = ReadonlyMap<string, ReadonlyMap<string, DefinitionSets>>;

/** Upstream's CT workflow or action has a shape or a condition that the check can't follow. */
export class CtMatrixError extends Error {}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((word, index) => word === b[index]);
}

/** Adds `definitions` to `sets` unless `sets` already holds them. */
function addDefinitions(sets: (readonly string[])[], definitions: readonly string[]): void {
	if (!sets.some((set) => sameWords(set, definitions))) {
		sets.push(definitions);
	}
}

const Step = z.looseObject({
	uses: z.string().optional(),
	if: z.union([z.string(), z.boolean()]).optional(),
	with: z.looseObject({ cflags: z.string().optional() }).optional(),
});

const Job = z.looseObject({
	if: z.union([z.string(), z.boolean()]).optional(),
	strategy: z
		.looseObject({
			matrix: z.looseObject({ "nix-shell": z.unknown() }).optional(),
		})
		.optional(),
	steps: z.array(Step).optional(),
});

const Workflow = z.looseObject({ jobs: z.record(z.string(), Job) });

/** One token of a condition: a name, a string literal, or an operator. */
type Token =
	| { readonly kind: "name"; readonly text: string }
	| { readonly kind: "string"; readonly text: string }
	| { readonly kind: "operator"; readonly text: "==" | "!=" | "&&" | "||" | "(" | ")" };

function tokenize(condition: string): readonly Token[] {
	const tokens: Token[] = [];
	const pattern = /\s*(?:(==|!=|&&|\|\||\(|\))|'((?:[^']|'')*)'|([A-Za-z_][\w.-]*))/y;
	let rest = condition.trim();
	while (rest !== "") {
		pattern.lastIndex = 0;
		const match = pattern.exec(rest);
		if (match === null) {
			throw new CtMatrixError(
				`The condition \`${condition}\` has syntax that the check can't evaluate.`,
			);
		}
		const [whole, operator, literal, name] = match;
		if (operator !== undefined) {
			tokens.push({
				kind: "operator",
				text: z.enum(["==", "!=", "&&", "||", "(", ")"]).parse(operator),
			});
		} else if (literal !== undefined) {
			tokens.push({ kind: "string", text: literal.replaceAll("''", "'") });
		} else {
			tokens.push({ kind: "name", text: name ?? "" });
		}
		rest = rest.slice(whole.length).trimStart();
	}
	return tokens;
}

/**
 * Evaluates a step's `if` condition for one `nix-shell` entry. GitHub
 * compares strings without regard to case, and `&&` binds tighter than `||`.
 */
function conditionHolds(condition: string, nixShell: string): boolean {
	const unwrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition)?.[1] ?? condition;
	const tokens = tokenize(unwrapped);
	let position = 0;
	const unsupported = (): never => {
		throw new CtMatrixError(
			`The condition \`${condition}\` has syntax that the check can't evaluate. It can compare only matrix.nix-shell with string literals.`,
		);
	};
	const operand = (): string => {
		const token = tokens[position];
		position += 1;
		if (token?.kind === "string") {
			return token.text.toLowerCase();
		}
		if (token?.kind === "name" && token.text === "matrix.nix-shell") {
			return nixShell.toLowerCase();
		}
		return unsupported();
	};
	const isOperator = (text: string): boolean => {
		const token = tokens[position];
		return token?.kind === "operator" && token.text === text;
	};
	const primary = (): boolean => {
		if (isOperator("(")) {
			position += 1;
			const value = disjunction();
			if (!isOperator(")")) {
				return unsupported();
			}
			position += 1;
			return value;
		}
		const left = operand();
		const equal = isOperator("==");
		if (!equal && !isOperator("!=")) {
			return unsupported();
		}
		position += 1;
		return (left === operand()) === equal;
	};
	const conjunction = (): boolean => {
		let value = primary();
		while (isOperator("&&")) {
			position += 1;
			value = primary() && value;
		}
		return value;
	};
	const disjunction = (): boolean => {
		let value = conjunction();
		while (isOperator("||")) {
			position += 1;
			value = conjunction() || value;
		}
		return value;
	};
	const value = disjunction();
	if (position !== tokens.length) {
		return unsupported();
	}
	return value;
}

/**
 * Reads the CT matrix from the text of `ct-tests.yml`. Throws a
 * {@link CtMatrixError} if no enabled job has a `nix-shell` list, or if the
 * file has a shape that the module comment above rules out.
 */
export function readCtMatrix(text: string): CtMatrix {
	const parsed = Workflow.safeParse(parse(text));
	if (!parsed.success) {
		throw new CtMatrixError(
			`${ctWorkflowPath} doesn't have the shape of a workflow with jobs: ${z.prettifyError(parsed.error)}`,
		);
	}
	const matrix = new Map<string, Map<string, (readonly string[])[]>>();
	for (const [jobName, job] of Object.entries(parsed.data.jobs)) {
		const jobMatrix = job.strategy?.matrix;
		const nixShells = jobMatrix?.["nix-shell"];
		if (jobMatrix === undefined || nixShells === undefined) {
			continue;
		}
		if ("include" in jobMatrix || "exclude" in jobMatrix) {
			throw new CtMatrixError(
				`The matrix of the job "${jobName}" has include or exclude entries, which the check can't follow.`,
			);
		}
		const list = z.array(z.string()).safeParse(nixShells);
		if (!list.success) {
			throw new CtMatrixError(
				`The nix-shell matrix of the job "${jobName}" isn't a list of names.`,
			);
		}
		// A job's own condition can't read the matrix, and the check can
		// evaluate only a literal true or false.
		if (job.if === false) {
			continue;
		}
		if (typeof job.if === "string") {
			throw new CtMatrixError(
				`The job "${jobName}" has the condition \`${job.if}\`, which the check can't evaluate.`,
			);
		}
		for (const nixShell of list.data) {
			const levels = matrix.get(nixShell) ?? new Map<string, (readonly string[])[]>();
			matrix.set(nixShell, levels);
			for (const step of job.steps ?? []) {
				if (step.uses !== `./${ctActionFolder}` || step.with?.cflags === undefined) {
					continue;
				}
				const runs =
					typeof step.if === "boolean"
						? step.if
						: step.if === undefined || conditionHolds(step.if, nixShell);
				const flags = step.with.cflags.split(/\s+/).filter((word) => word !== "");
				const [level, ...otherLevels] = flags.filter((word) => word.startsWith("-O"));
				const onlyDefinitions = flags.every(
					(word) => word.startsWith("-O") || word.startsWith("-D"),
				);
				if (!runs || level === undefined || otherLevels.length > 0 || !onlyDefinitions) {
					continue;
				}
				const sets = levels.get(level) ?? [];
				addDefinitions(
					sets,
					flags.filter((word) => word.startsWith("-D")),
				);
				levels.set(level, sets);
			}
		}
	}
	if (matrix.size === 0) {
		throw new CtMatrixError(`${ctWorkflowPath} has no enabled job with a nix-shell matrix list.`);
	}
	return matrix;
}

/** The clang major of a `nix-shell` entry, as in `valgrind-varlat_clang22`, or `undefined` for another compiler. */
export function clangMajor(nixShell: string): number | undefined {
	const major = /(?:^|[_-])clang(\d+)$/.exec(nixShell)?.[1];
	return major === undefined ? undefined : Number(major);
}

/** The newest clang major in the CT matrix, or `undefined` if no entry is a clang. */
export function newestClangMajor(matrix: CtMatrix): number | undefined {
	const majors = [...matrix.keys()].flatMap((nixShell) => clangMajor(nixShell) ?? []);
	return majors.length === 0 ? undefined : Math.max(...majors);
}

/**
 * The levels that the entries of the newest clang test, each with every
 * distinct definition set of the steps that test it. Empty if no entry is a
 * clang.
 */
export function newestClangLevels(matrix: CtMatrix): ReadonlyMap<string, DefinitionSets> {
	const newest = newestClangMajor(matrix);
	const levels = new Map<string, (readonly string[])[]>();
	for (const [nixShell, tested] of matrix) {
		if (newest === undefined || clangMajor(nixShell) !== newest) {
			continue;
		}
		for (const [level, sets] of tested) {
			const merged = levels.get(level) ?? [];
			for (const set of sets) {
				addDefinitions(merged, set);
			}
			levels.set(level, merged);
		}
	}
	return levels;
}

/**
 * The `-D` definitions of upstream's CT build of `level` with the newest
 * clang: `actionDefinitions`, which the CT action adds to every step, then
 * those of the step that tests the level. The config diff compares the
 * shipped config with the config that they select.
 *
 * @throws CtMatrixError if no step tests the level with the newest clang, or
 * if its steps test it with different definitions.
 */
export function ctDefinitions(
	matrix: CtMatrix,
	actionDefinitions: readonly string[],
	level: string,
): readonly string[] {
	const sets = newestClangLevels(matrix).get(level) ?? [];
	const [definitions, ...others] = sets;
	if (definitions === undefined || others.length > 0) {
		const given = sets.map((set) => `"${set.join(" ")}"`).join(" and ");
		throw new CtMatrixError(
			`The CT steps of the newest clang must test ${level} with one set of definitions, but they give ${sets.length === 0 ? "none" : given}.`,
		);
	}
	return [...actionDefinitions, ...definitions];
}

const Action = z.looseObject({
	runs: z.looseObject({ steps: z.array(z.looseObject({ run: z.string().optional() })) }),
});

/**
 * Reads the `-D` definitions that upstream's CT action adds to the `cflags` of
 * every CT step, from the `--cflags` value of its run commands. Throws a
 * {@link CtMatrixError} unless the action has exactly one `--cflags` value,
 * which holds only `-D` definitions and the step's `cflags` input.
 */
export function readCtActionDefinitions(text: string): readonly string[] {
	const parsed = Action.safeParse(parse(text));
	if (!parsed.success) {
		throw new CtMatrixError(
			`${ctActionPath} doesn't have the shape of a composite action with run steps: ${z.prettifyError(parsed.error)}`,
		);
	}
	const commands = parsed.data.runs.steps
		.flatMap((step) => step.run?.split("\n") ?? [])
		.filter((line) => !line.trim().startsWith("#"))
		.join("\n");
	const [value, ...otherValues] = [...commands.matchAll(/--cflags="([^"]*)"/g)].map(
		([, cflags = ""]) => cflags,
	);
	const stepInput = "${{ inputs.cflags }}";
	if (value === undefined || otherValues.length > 0 || !value.includes(stepInput)) {
		throw new CtMatrixError(
			`${ctActionPath} must pass exactly one --cflags value that holds ${stepInput}.`,
		);
	}
	const words = value
		.replace(stepInput, "")
		.split(/\s+/)
		.filter((word) => word !== "");
	if (!words.every((word) => word.startsWith("-D"))) {
		throw new CtMatrixError(
			`The --cflags value of ${ctActionPath} adds "${words.join(" ")}", but the check follows only -D definitions there.`,
		);
	}
	return words;
}
