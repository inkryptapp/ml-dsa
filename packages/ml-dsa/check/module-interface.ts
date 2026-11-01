/**
 * The module's interface: its exports with their wasm types, its imports, its
 * memory, and the globals that place the wasm stack and the end of memory.
 * The export list must equal the committed list in `module-exports.txt`, and
 * the package's TypeScript declaration of the raw exports must match it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { moduleFile } from "./files.ts";
import type {
	FunctionType,
	Global,
	GlobalType,
	Limits,
	ValueType,
	WasmModule,
} from "./wasm-binary.ts";
import { WasmFormatError } from "./wasm-binary.ts";

/** The committed export list, relative to the repo root. */
export const exportListFile = "packages/ml-dsa/check/module-exports.txt";

/** The file that declares the raw exports' TypeScript types, relative to the repo root. */
export const declarationFile = "packages/ml-dsa/src/module-exports.ts";

const pageBytes = 65_536;

/** One export with the type of what it exports. */
export type ExportEntry = { readonly name: string } & (
	| { readonly kind: "func"; readonly type: FunctionType }
	| { readonly kind: "table" | "memory"; readonly limits: Limits }
	| { readonly kind: "global"; readonly type: GlobalType }
);

/** Returns `items[index]`, or throws a {@link WasmFormatError} if the module refers to an item that doesn't exist. */
function at<Item>(items: readonly Item[], index: number, what: string): Item {
	const item = items[index];
	if (item === undefined) {
		throw new WasmFormatError(
			`The module refers to ${what} ${String(index)}, which doesn't exist.`,
		);
	}
	return item;
}

/**
 * The module's globals in the order of the global index space: the imported
 * ones, which have no initializer, then the ones that the module defines.
 */
function globalIndexSpace(module: WasmModule): readonly Global[] {
	return [
		...module.imports.flatMap((entry) =>
			entry.kind === "global" ? [{ type: entry.type, i32Value: undefined }] : [],
		),
		...module.globals,
	];
}

/** Returns each export of the module with the type of what it exports, in export order. */
export function exportEntries(module: WasmModule): readonly ExportEntry[] {
	const imported = <Kind extends WasmModule["imports"][number]["kind"]>(kind: Kind) =>
		module.imports.filter(
			(entry): entry is Extract<WasmModule["imports"][number], { kind: Kind }> =>
				entry.kind === kind,
		);
	const functionTypes = [
		...imported("func").map((entry) => entry.typeIndex),
		...module.functions,
	].map((typeIndex) => at(module.types, typeIndex, "type"));
	const tables = [...imported("table").map((entry) => entry.limits), ...module.tables];
	const memories = [...imported("memory").map((entry) => entry.limits), ...module.memories];
	const globals = globalIndexSpace(module).map((global) => global.type);
	return module.exports.map(({ name, kind, index }): ExportEntry => {
		switch (kind) {
			case "func":
				return { name, kind, type: at(functionTypes, index, "function") };
			case "table":
				return { name, kind, limits: at(tables, index, "table") };
			case "memory":
				return { name, kind, limits: at(memories, index, "memory") };
			case "global":
				return { name, kind, type: at(globals, index, "global") };
		}
	});
}

function signature(type: FunctionType): string {
	return `(${type.params.join(", ")}) -> (${type.results.join(", ")})`;
}

function limitsText(limits: Limits, unit: string): string {
	const max = limits.max === undefined ? "no max" : `max ${String(limits.max)}${unit}`;
	return `min ${String(limits.min)}${unit}, ${max}`;
}

/**
 * Renders one export as a line of the export list, such as
 * `mldsa_shake256_absorb: func (i32, i32, i32) -> ()`.
 */
export function exportLine(entry: ExportEntry): string {
	switch (entry.kind) {
		case "func":
			return `${entry.name}: func ${signature(entry.type)}`;
		case "table":
			return `${entry.name}: table (funcref, ${limitsText(entry.limits, "")})`;
		case "memory":
			return `${entry.name}: memory (${limitsText(entry.limits, " pages")}, ${entry.limits.shared ? "shared" : "unshared"})`;
		case "global":
			return `${entry.name}: global (${entry.type.valueType}, ${entry.type.mutable ? "mutable" : "immutable"})`;
	}
}

/**
 * Returns the messages for the module's imports and memories. The module
 * must import nothing, and each memory must have a maximum equal to its
 * initial size, so it can't grow.
 */
export function importAndMemoryFailures(module: WasmModule): readonly string[] {
	const failures = module.imports.map(
		(entry) =>
			`${moduleFile} imports the ${entry.kind} "${entry.name}" from "${entry.module}", but it must import nothing.`,
	);
	module.memories.forEach((limits, index) => {
		if (limits.max !== limits.min) {
			failures.push(
				`Memory ${String(index)} of ${moduleFile} has ${limitsText(limits, " pages")}, but its initial size must equal its maximum, so it can't grow.`,
			);
		}
	});
	return failures;
}

/** The sizes that `packages/ml-dsa/wasm/sizes.json` gives the build. */
export interface BuildSizes {
	readonly memoryBytes: number;
	readonly stackBytes: number;
}

/**
 * Returns the messages for the module's sizes, read from its bytes without a
 * rebuild. `__heap_end` and the memory must both span the memory size, and
 * `__stack_high` minus `__stack_low` must equal the wasm stack size.
 */
export function sizeFailures(module: WasmModule, sizes: BuildSizes): readonly string[] {
	const failures: string[] = [];
	const globals = globalIndexSpace(module);
	const exported = (name: string): number | undefined => {
		const entry = module.exports.find((item) => item.name === name && item.kind === "global");
		const global = entry === undefined ? undefined : globals[entry.index];
		if (global?.i32Value === undefined || global.type.mutable) {
			failures.push(
				`${moduleFile} must export ${name} as an immutable i32 global with an i32.const initializer.`,
			);
			return undefined;
		}
		return global.i32Value;
	};
	const [memory, ...otherMemories] = module.memories;
	if (memory === undefined || otherMemories.length > 0) {
		failures.push(`${moduleFile} must define exactly one memory.`);
	} else if (memory.min * pageBytes !== sizes.memoryBytes) {
		failures.push(
			`The memory of ${moduleFile} spans ${String(memory.min * pageBytes)} bytes, but sizes.json gives ${String(sizes.memoryBytes)}.`,
		);
	}
	const heapEnd = exported("__heap_end");
	if (heapEnd !== undefined && heapEnd !== sizes.memoryBytes) {
		failures.push(
			`__heap_end in ${moduleFile} is ${String(heapEnd)}, but it must equal the memory size, ${String(sizes.memoryBytes)} bytes in sizes.json.`,
		);
	}
	const stackLow = exported("__stack_low");
	const stackHigh = exported("__stack_high");
	if (
		stackLow !== undefined &&
		stackHigh !== undefined &&
		stackHigh - stackLow !== sizes.stackBytes
	) {
		failures.push(
			`__stack_high minus __stack_low in ${moduleFile} is ${String(stackHigh - stackLow)}, but it must equal the wasm stack size, ${String(sizes.stackBytes)} bytes in sizes.json.`,
		);
	}
	return failures;
}

/** The TypeScript type that a JavaScript caller passes or receives for a wasm value type. */
function typeScriptValue(valueType: ValueType): string {
	return valueType === "i64" ? "bigint" : "number";
}

/** The type-level check of one export, which evaluates to `true` when its declaration matches. */
function declarationCheck(entry: ExportEntry): string {
	const declared = `Declared<${JSON.stringify(entry.name)}>`;
	switch (entry.kind) {
		case "func": {
			const params = entry.type.params.map(typeScriptValue);
			const [result = "void"] = entry.type.results.map(typeScriptValue);
			return `Func<${declared}, [${params.join(", ")}], ${result}>`;
		}
		case "memory":
			return entry.limits.shared ? "false" : `Same<${declared}, WebAssembly.Memory>`;
		case "global": {
			const value = typeScriptValue(entry.type.valueType);
			return `Global<${declared}, ${entry.type.mutable ? `{ value: ${value} }` : `{ readonly value: ${value} }`}>`;
		}
		case "table":
			// The declaration has no type for a table export.
			return "false";
	}
}

/**
 * The source of a TypeScript module that type-checks only when the package's
 * declaration of the raw exports matches `entries`. A mismatch fails the
 * assignment at its end, with one error that names each export whose
 * declaration is missing or differs, and "the export names" when the
 * declaration and `entries` name different exports.
 */
export function declarationCheckSource(
	entries: readonly ExportEntry[],
	declarationPath: string,
): string {
	const checks = entries.map(
		(entry) => `\t${JSON.stringify(entry.name)}: ${declarationCheck(entry)};`,
	);
	const names = entries.map((entry) => JSON.stringify(entry.name)).join(" | ") || "never";
	return `import type { ModuleExports } from ${JSON.stringify(declarationPath)};

type Declared<Name extends string> = Name extends keyof ModuleExports ? ModuleExports[Name] : { readonly missing: Name };
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Fits<Declared, Wasm> = 0 extends 1 & Declared ? false : [Declared] extends [never] ? false : [Declared] extends [Wasm] ? true : false;
type Params<Declared, Wasm> = Declared extends readonly []
	? Wasm extends readonly [] ? true : false
	: Declared extends readonly [infer First, ...infer Rest]
		? Wasm extends readonly [infer WasmFirst, ...infer WasmRest]
			? Fits<First, WasmFirst> extends true ? Params<Rest, WasmRest> : false
			: false
		: false;
type Func<F, Wasm extends readonly unknown[], Result> = F extends (...args: infer P) => infer R
	? Params<P, Wasm> extends true
		? [Result] extends [void] ? Same<R, void> : Fits<R, Result>
		: false
	: false;
type Global<G, Value> = Same<G, WebAssembly.Global> extends true ? Same<Pick<WebAssembly.Global, "value">, Value> : false;

interface Checks {
${checks.join("\n")}
	"the export names": Same<keyof ModuleExports, ${names}>;
}

// The annotation repeats the mapped type instead of naming it, so that
// TypeScript prints the failed names in its error instead of an alias.
export const failed: [{ [K in keyof Checks]: Checks[K] extends true ? never : K }[keyof Checks]] extends [never]
	? "none"
	: { [K in keyof Checks]: Checks[K] extends true ? never : K }[keyof Checks] = "none";
`;
}

/**
 * Type-checks the package's declaration of the raw exports against
 * `entries` with the workspace's TypeScript, and returns one message with
 * TypeScript's errors if it doesn't match.
 */
export function declarationFailures(
	root: string,
	entries: readonly ExportEntry[],
): readonly string[] {
	const folder = mkdtempSync(join(tmpdir(), "ml-dsa-raw-exports-"));
	try {
		writeFileSync(
			join(folder, "check.mts"),
			declarationCheckSource(entries, join(root, declarationFile.replace(/\.ts$/, ".js"))),
		);
		writeFileSync(
			join(folder, "tsconfig.json"),
			JSON.stringify({
				extends: join(root, "tsconfig.base.json"),
				compilerOptions: {
					isolatedDeclarations: false,
					declaration: false,
					// The error must list every failed name.
					noErrorTruncation: true,
				},
				files: [join(root, "packages/ml-dsa/src/ambient.d.ts"), "check.mts"],
			}),
		);
		// From the folder, TypeScript names the generated file without the
		// temporary folder's path.
		const result = spawnSync(join(root, "node_modules/.bin/tsc"), ["-p", "."], {
			cwd: folder,
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1" },
		});
		if (result.error !== undefined) {
			throw result.error;
		}
		if (result.status === 0) {
			return [];
		}
		return [
			`The declaration of the raw exports in ${declarationFile} doesn't match the module's exports in ${exportListFile}. In the generated check, TypeScript names each export whose declaration is missing or differs, and "the export names" when the declaration and the module name different exports:\n${result.stdout.trim()}`,
		];
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}
