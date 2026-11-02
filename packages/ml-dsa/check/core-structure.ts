/**
 * The structural check of the core function. Its cleanup must still run when
 * too little engine stack is left to start a function call, a `new`, or a
 * getter. So the check parses the TypeScript source and each shipped entry
 * file, finds the core function by name, and walks every `catch` and
 * `finally` block inside it.
 *
 * Those blocks may hold only these:
 *
 * - Exactly four calls, each alone in an expression statement directly in
 *   the `try` block of one of the three `try` statements in the `finally`
 *   block. The first `try` holds the release, whose callee is a `const`
 *   local. The second holds two fills and the third holds one, and a fill is
 *   `fill` called on a `const` local. Each call passes only `const` locals
 *   and number literals.
 * - In the third `try` statement's `catch` block, the fallback loop: `for
 *   (let i = 0; i < bound; i += 1)`, whose body only stores `0` into a `const`
 *   local at `i`.
 * - Assignments of a name or a literal to `failure` or `poisoned`.
 * - A `catch` binding that is a single name, or none. A destructured binding
 *   reads the error's properties.
 * - `if` statements in the `finally` block, whose conditions read names and
 *   literals with `!`, `&&`, `||`, `===`, and `!==` only.
 * - The three `checkedOut` statements of the `finally` block, which name the
 *   call's instance. The block's first statement is the first check, `if
 *   (checkedOut !== held) { poisoned = true; }`, which appears once. The
 *   block's last two statements are the put-back, `if (!poisoned) { slot =
 *   held; }`, and the clear, `if (checkedOut === held) { checkedOut = null;
 *   }`. No other statement reads `checkedOut` in a condition or assigns it or
 *   the slot.
 *
 * Here `held` stands for the name in the core's one checkout, `checkedOut =
 * held`, outside the `catch` and `finally` blocks, and `slot = null` must
 * follow that checkout directly. These rules keep `checkedOut` set until the
 * last statement of a call's `finally` block, so the next call finds the
 * instance of a stopped call.
 *
 * Anything else fails the check, any other call, `new`, or member read
 * included. The rules catch the code that an author adds by mistake, such as
 * a helper call or a log line in a `catch` block. They read only the syntax,
 * so code written to evade them, for example through a `const` local that
 * holds a Proxy, can still run code in the cleanup. Review covers that.
 */
import { child, children, field, nameOf, parseProgram, walk, type Node } from "./estree.ts";

/** The name of the core function, which appears exactly once in each file that the check reads. */
const coreFunction = "runCore";

/** The bindings that a `catch` or `finally` block of the core may assign anywhere. */
const assignable = new Set(["failure", "poisoned"]);

/**
 * The bindings that the core's `catch` and `finally` blocks may assign in one
 * statement only, each mapped to the name of that statement.
 */
const placed: ReadonlyMap<string, string> = new Map([
	["slot", "the put-back"],
	["checkedOut", "the clear of `checkedOut`"],
]);

/**
 * The names that a declaration's pattern binds, such as `b` and `c` in
 * `const { a: b, c } = d`, where the key `a` binds nothing.
 */
function boundNames(pattern: Node | null): readonly string[] {
	switch (pattern?.type) {
		case "Identifier": {
			const name = nameOf(pattern);
			return name === null ? [] : [name];
		}
		case "ObjectPattern":
			return children(pattern, "properties").flatMap((property) =>
				boundNames(child(property, property.type === "RestElement" ? "argument" : "value")),
			);
		case "ArrayPattern":
			return children(pattern, "elements").flatMap((element) => boundNames(element));
		case "AssignmentPattern":
			return boundNames(child(pattern, "left"));
		case "RestElement":
			return boundNames(child(pattern, "argument"));
		default:
			return [];
	}
}

/** One of the four calls that the cleanup may make. */
type DesignatedCall = "release" | "fill";

/** One of the three `checkedOut` statements of the `finally` block, which the file's header lists. */
type CheckoutStatement = "first check" | "put-back" | "clear";

/**
 * The statements of an `if` branch or a loop body. A bundler drops the braces
 * around a single statement, which runs the same code.
 */
function bodyStatements(node: Node | null): readonly Node[] {
	if (node === null) {
		return [];
	}
	return node.type === "BlockStatement" ? children(node, "body") : [node];
}

/** The right-hand side of `statement` if it is `target = value;`, or `null`. */
function assignedValue(statement: Node | undefined, target: string): Node | null {
	const expression =
		statement?.type === "ExpressionStatement" ? child(statement, "expression") : null;
	return expression?.type === "AssignmentExpression" &&
		field(expression, "operator") === "=" &&
		nameOf(child(expression, "left")) === target
		? child(expression, "right")
		: null;
}

/** Whether `node` is the literal whose source text is `raw`, such as `true` or `null`. */
function isRaw(node: Node | null, raw: string): boolean {
	return node?.type === "Literal" && field(node, "raw") === raw;
}

/** Whether `node` is `checkedOut <operator> held`. */
function comparesHeld(node: Node | null, operator: string, held: string): boolean {
	return (
		node?.type === "BinaryExpression" &&
		field(node, "operator") === operator &&
		nameOf(child(node, "left")) === "checkedOut" &&
		nameOf(child(node, "right")) === held
	);
}

/** Which of the three `checkedOut` statements `node` is, for the call's instance `held`, or `null`. */
function checkoutStatement(node: Node, held: string | null): CheckoutStatement | null {
	const test = child(node, "test");
	const body = bodyStatements(child(node, "consequent"));
	const [only] = body;
	if (held === null || child(node, "alternate") !== null || body.length !== 1) {
		return null;
	}
	if (comparesHeld(test, "!==", held) && isRaw(assignedValue(only, "poisoned"), "true")) {
		return "first check";
	}
	if (comparesHeld(test, "===", held) && isRaw(assignedValue(only, "checkedOut"), "null")) {
		return "clear";
	}
	const negated = test?.type === "UnaryExpression" && field(test, "operator") === "!";
	if (
		negated &&
		nameOf(child(test, "argument")) === "poisoned" &&
		nameOf(assignedValue(only, "slot")) === held
	) {
		return "put-back";
	}
	return null;
}

function readsCheckedOut(node: Node | null): boolean {
	return node !== null && [...walk(node)].some((inner) => nameOf(inner) === "checkedOut");
}

/** Where in the core a node sits. */
interface Context {
	readonly region: "catch" | "finally";
	/** The index of the `try` statement of the `finally` block whose `try` block holds the node. */
	readonly tryIndex: number | null;
	/** Whether the node sits in the third `try` statement's `catch` block, which holds the fallback loop. */
	readonly fallback: boolean;
}

class Checker {
	readonly failures: string[] = [];
	readonly #file: string;
	readonly #lineStarts: readonly number[];
	readonly #constLocals: ReadonlySet<string>;
	/** The name of the call's instance, which the checkout assigns to `checkedOut`. */
	readonly #held: string | null;
	/** The calls in the `try` block of each `try` statement of the `finally` block. */
	readonly calls: DesignatedCall[][] = [];
	/** The `checkedOut` statements of the `finally` block, by node. */
	readonly checkoutStatements = new Map<Node, CheckoutStatement>();

	constructor(file: string, source: string, constLocals: ReadonlySet<string>, held: string | null) {
		this.#file = file;
		this.#lineStarts = [0, ...[...source.matchAll(/\n/gu)].map((match) => match.index + 1)];
		this.#constLocals = constLocals;
		this.#held = held;
	}

	fail(node: Node, message: string): void {
		const line = this.#lineStarts.findLastIndex((start) => start <= node.start) + 1;
		this.failures.push(`${this.#file}:${line}: ${message}`);
	}

	#refuse(node: Node, context: Context, what: string): void {
		this.fail(
			node,
			`the core's ${context.region} block holds ${what}, which can fail to start at the engine's stack limit.`,
		);
	}

	#isConstLocal(node: Node | null): boolean {
		const name = nameOf(node);
		return name !== null && this.#constLocals.has(name);
	}

	/** A `const` local or a number literal, the only arguments that a designated call may pass. */
	#isArgument(node: Node): boolean {
		return (
			this.#isConstLocal(node) ||
			(node.type === "Literal" && typeof field(node, "value") === "number")
		);
	}

	/** Checks the `catch` clause of `tryStatement`, its binding and its block. */
	catchClause(tryStatement: Node, context: Context): void {
		const handler = child(tryStatement, "handler");
		if (handler === null) {
			return;
		}
		const binding = child(handler, "param");
		if (binding !== null && binding.type !== "Identifier") {
			this.#refuse(
				binding,
				context,
				"a destructured `catch` binding, which reads the error's properties",
			);
		}
		const body = child(handler, "body");
		if (body !== null) {
			this.statement(body, context, false);
		}
	}

	statement(node: Node, context: Context, directlyInTry: boolean): void {
		switch (node.type) {
			case "BlockStatement":
				for (const statement of children(node, "body")) {
					this.statement(statement, context, directlyInTry);
				}
				return;
			case "EmptyStatement":
				return;
			case "ExpressionStatement": {
				const expression = child(node, "expression");
				if (expression?.type === "CallExpression" && directlyInTry) {
					this.#designatedCall(expression, context);
				} else if (expression !== null) {
					this.#assignment(expression, context);
				}
				return;
			}
			case "IfStatement": {
				if (context.region !== "finally") {
					this.#refuse(node, context, "an `if` statement");
					return;
				}
				const kind = checkoutStatement(node, this.#held);
				if (kind !== null) {
					this.checkoutStatements.set(node, kind);
					return;
				}
				if (readsCheckedOut(child(node, "test"))) {
					this.fail(
						node,
						`the core's finally block holds an \`if\` on \`checkedOut\` that is neither \`if (checkedOut !== ${this.#held ?? "held"}) { poisoned = true; }\` nor the clear of \`checkedOut\`.`,
					);
					return;
				}
				this.#condition(child(node, "test"), context);
				for (const branch of [child(node, "consequent"), child(node, "alternate")]) {
					if (branch !== null) {
						this.statement(branch, context, false);
					}
				}
				return;
			}
			case "TryStatement":
				this.#tryStatement(node, context);
				return;
			case "ForStatement":
				if (context.fallback) {
					this.#fallbackLoop(node, context);
					return;
				}
				this.#refuse(node, context, "a loop outside the fallback");
				return;
			default:
				this.#refuse(node, context, describe(node));
		}
	}

	#tryStatement(node: Node, context: Context): void {
		if (context.region !== "finally" || context.tryIndex !== null || child(node, "finalizer")) {
			this.#refuse(node, context, "a nested `try` statement");
			return;
		}
		const tryIndex = this.calls.length;
		this.calls.push([]);
		const block = child(node, "block");
		if (block !== null) {
			this.statement(block, { ...context, tryIndex }, true);
		}
		this.catchClause(node, { region: "catch", tryIndex: null, fallback: tryIndex === 2 });
	}

	#designatedCall(node: Node, context: Context): void {
		const callee = child(node, "callee");
		const tryIndex = context.tryIndex ?? 0;
		const args = children(node, "arguments");
		if (!args.every((argument) => this.#isArgument(argument))) {
			this.#refuse(
				node,
				context,
				"a call whose arguments aren't all `const` locals or number literals",
			);
		}
		if (callee?.type === "Identifier") {
			if (!this.#isConstLocal(callee)) {
				this.fail(
					node,
					`the release calls \`${nameOf(callee) ?? ""}\`, which isn't a \`const\` local of ${coreFunction}.`,
				);
			}
			this.calls[tryIndex]?.push("release");
			return;
		}
		const property = callee === null ? null : child(callee, "property");
		if (
			callee?.type === "MemberExpression" &&
			field(callee, "computed") === false &&
			nameOf(property) === "fill" &&
			this.#isConstLocal(child(callee, "object"))
		) {
			this.calls[tryIndex]?.push("fill");
			return;
		}
		this.#refuse(node, context, "a call that is neither the release nor a fill on a `const` local");
	}

	#assignment(node: Node, context: Context): void {
		if (node.type !== "AssignmentExpression") {
			this.#refuse(node, context, describe(node));
			return;
		}
		const target = nameOf(child(node, "left"));
		const value = child(node, "right");
		const place = target === null ? undefined : placed.get(target);
		if (place !== undefined) {
			this.fail(
				node,
				`the core's ${context.region} block assigns \`${target ?? ""}\` outside ${place}.`,
			);
			return;
		}
		if (field(node, "operator") !== "=" || target === null || !assignable.has(target)) {
			this.#refuse(node, context, `an assignment to \`${target ?? "a member"}\``);
			return;
		}
		if (value === null || !(value.type === "Identifier" || value.type === "Literal")) {
			this.#refuse(value ?? node, context, describe(value ?? node));
		}
	}

	#condition(node: Node | null, context: Context): void {
		if (node === null) {
			return;
		}
		const operator = field(node, "operator");
		switch (node.type) {
			case "Identifier":
			case "Literal":
				return;
			case "UnaryExpression":
				if (operator === "!") {
					this.#condition(child(node, "argument"), context);
					return;
				}
				break;
			case "LogicalExpression":
			case "BinaryExpression":
				if (operator === "&&" || operator === "||" || operator === "===" || operator === "!==") {
					this.#condition(child(node, "left"), context);
					this.#condition(child(node, "right"), context);
					return;
				}
				break;
			default:
				break;
		}
		this.#refuse(node, context, describe(node));
	}

	#fallbackLoop(node: Node, context: Context): void {
		const init = child(node, "init");
		const declarations = init === null ? [] : children(init, "declarations");
		const declarator = declarations[0];
		const counter = declarator === undefined ? null : nameOf(child(declarator, "id"));
		const start = declarator === undefined ? null : child(declarator, "init");
		const test = child(node, "test");
		const update = child(node, "update");
		const stores = bodyStatements(child(node, "body"));
		const isStore = (statement: Node): boolean => {
			const store = child(statement, "expression");
			const target = store === null ? null : child(store, "left");
			return (
				statement.type === "ExpressionStatement" &&
				store?.type === "AssignmentExpression" &&
				field(store, "operator") === "=" &&
				target?.type === "MemberExpression" &&
				field(target, "computed") === true &&
				this.#isConstLocal(child(target, "object")) &&
				nameOf(child(target, "property")) === counter &&
				isZero(child(store, "right"))
			);
		};
		const valid =
			init?.type === "VariableDeclaration" &&
			field(init, "kind") === "let" &&
			declarations.length === 1 &&
			counter !== null &&
			isZero(start) &&
			test?.type === "BinaryExpression" &&
			field(test, "operator") === "<" &&
			nameOf(child(test, "left")) === counter &&
			child(test, "right")?.type === "Identifier" &&
			update?.type === "AssignmentExpression" &&
			field(update, "operator") === "+=" &&
			nameOf(child(update, "left")) === counter &&
			isNumber(child(update, "right"), 1) &&
			stores.length > 0 &&
			stores.every(isStore);
		if (!valid) {
			this.#refuse(node, context, "a loop that does more than store 0 into a `const` local view");
		}
	}
}

function isNumber(node: Node | null, value: number): boolean {
	return node?.type === "Literal" && field(node, "value") === value;
}

function isZero(node: Node | null): boolean {
	return isNumber(node, 0);
}

function describe(node: Node): string {
	switch (node.type) {
		case "CallExpression":
			return "a call outside the four designated calls";
		case "NewExpression":
			return "a `new`";
		case "MemberExpression":
			return "a member read, which can run a getter";
		default:
			return `${/^[AEIOU]/u.test(node.type) ? "an" : "a"} ${node.type}`;
	}
}

/** The calls that each `try` statement of the `finally` block must hold, in order. */
const designatedCalls: readonly (readonly DesignatedCall[])[] = [
	["release"],
	["fill", "fill"],
	["fill"],
];

/**
 * Checks the `catch` and `finally` blocks of the core function in `source`,
 * and returns one message per broken rule, each with the file and the line.
 */
export function coreStructureFailures(file: string, source: string): readonly string[] {
	const cores = [...walk(parseProgram(file, source))].filter(
		(node) => node.type === "FunctionDeclaration" && nameOf(child(node, "id")) === coreFunction,
	);
	const [core] = cores;
	if (cores.length !== 1 || core === undefined) {
		return [
			`${file}: the source holds ${cores.length} functions named ${coreFunction} instead of one.`,
		];
	}
	const constLocals = new Set(
		[...walk(core)]
			.filter((node) => node.type === "VariableDeclaration" && field(node, "kind") === "const")
			.flatMap((node) => children(node, "declarations"))
			.flatMap((declarator) => boundNames(child(declarator, "id"))),
	);
	const tries = [...walk(core)].filter((node) => node.type === "TryStatement");
	// Every node of the core's `catch` and `finally` blocks.
	const cleanup = new Set(
		tries
			.flatMap((node) => [child(node, "handler"), child(node, "finalizer")])
			.flatMap((block) => (block === null ? [] : [...walk(block)])),
	);
	const checkouts = [...walk(core)].flatMap((node) => {
		const body = cleanup.has(node) ? [] : children(node, "body");
		return body.flatMap((statement, index) => {
			const held = nameOf(assignedValue(statement, "checkedOut"));
			return held === null ? [] : [{ statement, held, next: body[index + 1] }];
		});
	});
	const [checkout] = checkouts;
	const held = checkouts.length === 1 && checkout !== undefined ? checkout.held : null;
	const checker = new Checker(file, source, constLocals, held);
	if (checkout === undefined || held === null) {
		checker.fail(
			core,
			`${coreFunction} holds ${checkouts.length} checkouts, \`checkedOut = <instance>;\`, instead of one.`,
		);
	} else if (!isRaw(assignedValue(checkout.next, "slot"), "null")) {
		checker.fail(
			checkout.statement,
			`the checkout \`checkedOut = ${held};\` isn't directly followed by \`slot = null;\`.`,
		);
	}
	// The checker walks each `catch` and `finally` block whole, so it starts
	// only from the `try` statements that no such block holds.
	const finallyBlocks: Node[] = [];
	for (const node of tries.filter((candidate) => !cleanup.has(candidate))) {
		checker.catchClause(node, { region: "catch", tryIndex: null, fallback: false });
		const finalizer = child(node, "finalizer");
		if (finalizer !== null) {
			finallyBlocks.push(finalizer);
			checker.statement(finalizer, { region: "finally", tryIndex: null, fallback: false }, false);
		}
	}
	if (finallyBlocks.length !== 1) {
		checker.fail(
			core,
			`${coreFunction} holds ${finallyBlocks.length} \`finally\` blocks instead of one.`,
		);
	}
	const [finalizer] = finallyBlocks;
	if (finallyBlocks.length === 1 && finalizer !== undefined && held !== null) {
		const statements = children(finalizer, "body");
		const kindOf = (node: Node | undefined): CheckoutStatement | null =>
			node === undefined ? null : (checker.checkoutStatements.get(node) ?? null);
		const count = (kind: CheckoutStatement): number =>
			[...checker.checkoutStatements.values()].filter((candidate) => candidate === kind).length;
		if (kindOf(statements[0]) !== "first check" || count("first check") !== 1) {
			checker.fail(
				finalizer,
				`the core's finally block doesn't start with \`if (checkedOut !== ${held}) { poisoned = true; }\`, or holds that check twice.`,
			);
		}
		if (
			kindOf(statements.at(-2)) !== "put-back" ||
			kindOf(statements.at(-1)) !== "clear" ||
			count("put-back") !== 1 ||
			count("clear") !== 1
		) {
			checker.fail(
				finalizer,
				`the core's finally block doesn't end with the put-back, \`if (!poisoned) { slot = ${held}; }\`, and then \`if (checkedOut === ${held}) { checkedOut = null; }\`.`,
			);
		}
	}
	const found = JSON.stringify(checker.calls);
	if (found !== JSON.stringify(designatedCalls)) {
		checker.fail(
			finallyBlocks[0] ?? core,
			`the \`try\` statements of the \`finally\` block hold the calls ${found} instead of ${JSON.stringify(designatedCalls)}.`,
		);
	}
	return checker.failures;
}
