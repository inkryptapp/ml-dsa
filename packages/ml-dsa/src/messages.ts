// Every message that the shipped package throws. A message holds only package
// constants, computed numbers, and `typeof` results, so it never holds a
// caller's bytes. A message about a call's input reads `<object>.<operation>:
// <input> <rule>.`, where the site supplies `<object>.<operation>`.

import type { ObjectName } from "./parameter-sets.js";

/** The exported object and the operation that a call runs, such as `mlDsa44.keygen`. */
export type Site = `${ObjectName}.${"keygen" | "sign" | "verify"}`;

/** A byte input that a call checks. */
export type ByteInput = "seed";

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

export function missing(site: Site, input: ByteInput): string {
	return `${site}: ${input} is required.`;
}

export function notUint8Array(site: Site, input: ByteInput, type: TypeofResult): string {
	return `${site}: ${input} must be a Uint8Array, but typeof ${input} is "${type}".`;
}

export function badSecretBacking(site: Site, input: ByteInput, length: number): string {
	return `${site}: ${input} must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as new Uint8Array(new ArrayBuffer(${length})) filled with set.`;
}

export function wrongLength(site: Site, input: ByteInput, length: number): string {
	return `${site}: ${input} must be ${length} bytes long.`;
}

export function allZero(site: Site, input: ByteInput): string {
	return `${site}: ${input} must not be all zeros.`;
}

export function failed(site: Site): string {
	return `${site}: the call failed.`;
}

export function notImplemented(site: Site): string {
	return `${site}: the operation is not implemented yet.`;
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
