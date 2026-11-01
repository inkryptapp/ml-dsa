// Every message that the shipped package throws. A message holds only package
// constants, computed numbers, and `typeof` results, so it never holds a
// caller's bytes. A message about a call's input reads `<object>.<operation>:
// <input> <rule>.`, where the site supplies `<object>.<operation>`, and a hint
// may follow the rule.

import { maxContextBytes, seedBytes, randomnessBytes, type ObjectName } from "./parameter-sets.js";

/** The exported object and the operation that a call runs, such as `mlDsa44.keygen`. */
export type Site = `${ObjectName}.${"keygen" | "sign" | "verify"}`;

/**
 * A byte input that a call checks. Only the test-only entry point checks
 * `secretKey` and `messageRepresentative`.
 */
export type ByteInput =
	| "seed"
	| "message"
	| "context"
	| "randomness"
	| "publicKey"
	| "signature"
	| "secretKey"
	| "messageRepresentative";

/** A result of the `typeof` operator. */
type TypeofResult =
	| "undefined"
	| "object"
	| "boolean"
	| "number"
	| "bigint"
	| "string"
	| "symbol"
	| "function";

export function notOptionsObject(site: Site, type: TypeofResult): string {
	return `${site}: options must be an object, but typeof options is "${type}".`;
}

export function nullOptions(site: Site): string {
	return `${site}: options must be an object, not null.`;
}

export function notPlainObject(site: Site): string {
	return `${site}: options must be a plain object, whose prototype is Object.prototype or null.`;
}

export function unknownOption(site: Site, known: readonly string[]): string {
	return `${site}: options may hold only these keys: ${known.join(", ")}.`;
}

export function missing(site: Site, input: ByteInput): string {
	return `${site}: ${input} is required.`;
}

export function notUint8Array(site: Site, input: ByteInput, type: TypeofResult): string {
	const allowed = input === "randomness" ? 'a Uint8Array or "deterministic"' : "a Uint8Array";
	return `${site}: ${input} must be ${allowed}, but typeof ${input} is "${type}".`;
}

const backing = "backed by a fixed-length, non-shared, non-detached ArrayBuffer";

export function badBacking(site: Site, input: ByteInput): string {
	if (input === "seed" || input === "randomness") {
		const length = input === "seed" ? seedBytes : randomnessBytes;
		return `${site}: ${input} must be ${backing}, such as new Uint8Array(new ArrayBuffer(${length})) filled with set.`;
	}
	return `${site}: ${input} must be ${backing}, such as the copy that new Uint8Array(${input}) makes.`;
}

export function wrongLength(site: Site, input: ByteInput, length: number): string {
	return `${site}: ${input} must be ${length} bytes long.`;
}

export function contextTooLong(site: Site, length: number): string {
	return `${site}: context must be at most ${maxContextBytes} bytes long, but it is ${length} bytes long.`;
}

export function allZero(site: Site, input: "seed" | "randomness"): string {
	const hint = input === "randomness" ? ' Pass "deterministic" for the deterministic variant.' : "";
	return `${site}: ${input} must not be all zeros.${hint}`;
}

export function failed(site: Site): string {
	return `${site}: the call failed.`;
}

export function missingGetter(getter: string): string {
	return `ml-dsa: this runtime lacks the ${getter} getter, which the package needs to check its inputs.`;
}

export function noModule(): string {
	return "ml-dsa: no wasm module was given to the package before its first instance.";
}

export function badGeometry(): string {
	return "ml-dsa: the wasm module's memory doesn't have the layout that the package was built for.";
}

export function regionsOverflow(): string {
	return "ml-dsa: the package's memory regions don't fit between __heap_base and __heap_end.";
}
