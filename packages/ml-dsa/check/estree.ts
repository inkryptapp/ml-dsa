/**
 * The parser and the readers for the ESTree nodes that it returns. The
 * readers read a node's fields by name, so the checks walk any node without
 * a type assertion, which the lint bans.
 */
import { parseAst } from "vite/rolldown/parseAst";

/** An ESTree node, with the offset of its first character. */
export interface Node {
	readonly type: string;
	readonly start: number;
}

/** Whether `value` is a node: an object with a string `type`. */
export function isNode(value: unknown): value is Node {
	return (
		typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
	);
}

/** The node in a field, or `null` when the field holds none. */
export function child(node: Node, key: string): Node | null {
	const value: unknown = Reflect.get(node, key);
	return isNode(value) ? value : null;
}

/** The nodes in a field that holds a list. */
export function children(node: Node, key: string): readonly Node[] {
	const value: unknown = Reflect.get(node, key);
	return Array.isArray(value) ? value.filter(isNode) : [];
}

/** The value of a node's field, of any shape. */
export function field(node: Node, key: string): unknown {
	return Reflect.get(node, key);
}

/** Every node under `node`, depth first and in source order, with `node` itself. */
export function* walk(node: Node): Generator<Node> {
	yield node;
	for (const value of Object.values(node)) {
		const nodes: readonly unknown[] = Array.isArray(value) ? value : [value];
		for (const item of nodes) {
			if (isNode(item)) {
				yield* walk(item);
			}
		}
	}
}

/** The name of an identifier, or `null` for any other node. */
export function nameOf(node: Node | null): string | null {
	if (node === null || node.type !== "Identifier") {
		return null;
	}
	const name = field(node, "name");
	return typeof name === "string" ? name : null;
}

/**
 * Parses `source`, the text of `file`, as a declaration file, TypeScript, or
 * JavaScript by the file's extension.
 *
 * @throws Error when the source doesn't parse.
 */
export function parseProgram(file: string, source: string): Node {
	const lang = file.endsWith(".d.ts") ? "dts" : file.endsWith(".ts") ? "ts" : "js";
	const program: unknown = parseAst(source, { lang }, file);
	if (!isNode(program)) {
		throw new Error(`${file}: the parser returned no program.`);
	}
	return program;
}
