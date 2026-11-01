import * as messages from "./messages.js";
import type { ByteInput, Site } from "./messages.js";
import { maxContextBytes, randomnessBytes } from "./parameter-sets.js";

// The checks read a caller's array only through these six getters, looked up
// once at load. An own property or a subclass getter can report a `length`
// or `byteOffset` that `set` doesn't copy, and `instanceof` rejects an array
// from another realm and accepts a Proxy.

type Getter = NonNullable<PropertyDescriptor["get"]>;

function lookUpGetter(target: object | null, key: string | symbol, getter: string): Getter {
	const get = target === null ? undefined : Reflect.getOwnPropertyDescriptor(target, key)?.get;
	if (get === undefined) {
		throw new Error(messages.missingGetter(getter));
	}
	return get;
}

const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype);

// `lookUpGetter` returns a getter typed with an `any` result, so each
// annotation below states the result that the ECMAScript spec defines.

// Returns the array's type name, or `undefined` for any value that isn't a
// typed array, a Proxy included. It never throws.
const typedArrayName: (this: unknown) => string | undefined = lookUpGetter(
	typedArrayPrototype,
	Symbol.toStringTag,
	"%TypedArray%.prototype[Symbol.toStringTag]",
);
const bufferOf: (this: Uint8Array) => ArrayBufferLike = lookUpGetter(
	typedArrayPrototype,
	"buffer",
	"%TypedArray%.prototype.buffer",
);
const byteOffsetOf: (this: Uint8Array) => number = lookUpGetter(
	typedArrayPrototype,
	"byteOffset",
	"%TypedArray%.prototype.byteOffset",
);
const lengthOf: (this: Uint8Array) => number = lookUpGetter(
	typedArrayPrototype,
	"length",
	"%TypedArray%.prototype.length",
);
const isResizable: (this: ArrayBufferLike) => boolean = lookUpGetter(
	ArrayBuffer.prototype,
	"resizable",
	"ArrayBuffer.prototype.resizable",
);
const isDetached: (this: ArrayBufferLike) => boolean = lookUpGetter(
	ArrayBuffer.prototype,
	"detached",
	"ArrayBuffer.prototype.detached",
);

function isUint8Array(value: unknown): value is Uint8Array {
	return typedArrayName.call(value) === "Uint8Array";
}

// The `resizable` getter throws a `TypeError` on a `SharedArrayBuffer`, so it
// is also the shared-buffer check. Any other error, such as the engine's stack
// overflow, reaches the caller unchanged.
function isSharedOrResizable(buffer: ArrayBufferLike): boolean {
	try {
		return isResizable.call(buffer);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			Reflect.getPrototypeOf(error) === TypeError.prototype
		) {
			return true;
		}
		throw error;
	}
}

/**
 * Checks a byte input of any length, such as a message, for presence, type,
 * then backing, and returns a view of exactly its bytes. Later checks and the
 * core read only that view.
 *
 * @throws TypeError if the input is missing, isn't a `Uint8Array`, or sits on
 * a shared, resizable, or detached buffer.
 */
export function checkBytes(site: Site, input: ByteInput, value: unknown): Uint8Array {
	if (value === undefined) {
		throw new TypeError(messages.missing(site, input));
	}
	if (!isUint8Array(value)) {
		throw new TypeError(messages.notUint8Array(site, input, typeof value));
	}
	const buffer = bufferOf.call(value);
	if (isSharedOrResizable(buffer) || isDetached.call(buffer)) {
		throw new TypeError(messages.badBacking(site, input));
	}
	return new Uint8Array(buffer, byteOffsetOf.call(value), lengthOf.call(value));
}

/**
 * Checks a byte input of one fixed length, such as a seed, and returns a view
 * of exactly its bytes.
 *
 * @throws TypeError if the input is missing, isn't a `Uint8Array`, or sits on
 * a shared, resizable, or detached buffer.
 * @throws RangeError if the input isn't `length` bytes long.
 */
export function checkExactBytes(
	site: Site,
	input: ByteInput,
	value: unknown,
	length: number,
): Uint8Array {
	const view = checkBytes(site, input, value);
	if (view.length !== length) {
		throw new RangeError(messages.wrongLength(site, input, length));
	}
	return view;
}

/**
 * Checks an optional context string and returns a view of exactly its bytes.
 * A missing context is the empty context string.
 *
 * @throws TypeError if the context isn't a `Uint8Array`, or sits on a shared,
 * resizable, or detached buffer.
 * @throws RangeError if the context is longer than 255 bytes.
 */
export function checkContext(site: Site, value: unknown): Uint8Array {
	if (value === undefined) {
		return new Uint8Array(0);
	}
	const view = checkBytes(site, "context", value);
	if (view.length > maxContextBytes) {
		throw new RangeError(messages.contextTooLong(site, view.length));
	}
	return view;
}

/**
 * Checks the signing randomness, which is either the exact string
 * `"deterministic"` or 32 bytes.
 *
 * @throws TypeError if the randomness is missing, is neither a `Uint8Array`
 * nor `"deterministic"`, or sits on a shared, resizable, or detached buffer.
 * @throws RangeError if the randomness isn't 32 bytes long.
 */
export function checkRandomness(site: Site, value: unknown): Uint8Array | "deterministic" {
	if (value === "deterministic") {
		return value;
	}
	return checkExactBytes(site, "randomness", value, randomnessBytes);
}

/**
 * Whether every byte is zero. It ORs every byte with no early exit, so its
 * running time doesn't depend on where a secret's first non-zero byte sits.
 */
export function isAllZero(bytes: Uint8Array): boolean {
	let bits = 0;
	for (const byte of bytes) {
		bits |= byte;
	}
	return bits === 0;
}
