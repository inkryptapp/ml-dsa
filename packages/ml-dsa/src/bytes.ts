import * as messages from "./messages.js";
import type { ByteInput, Site } from "./messages.js";

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
 * Checks a secret byte input, such as a seed, for presence, type, backing,
 * then length, and returns a view of exactly its bytes. The zero check and the
 * core read only that view.
 *
 * @throws TypeError if the input is missing, isn't a `Uint8Array`, or sits on
 * a shared, resizable, or detached buffer.
 * @throws RangeError if the input isn't `length` bytes long.
 */
export function checkSecretBytes(
	site: Site,
	input: ByteInput,
	value: unknown,
	length: number,
): Uint8Array {
	if (value === undefined) {
		throw new TypeError(messages.missing(site, input));
	}
	if (!isUint8Array(value)) {
		throw new TypeError(messages.notUint8Array(site, input, typeof value));
	}
	const buffer = bufferOf.call(value);
	if (isSharedOrResizable(buffer) || isDetached.call(buffer)) {
		throw new TypeError(messages.badSecretBacking(site, input, length));
	}
	const byteLength = lengthOf.call(value);
	if (byteLength !== length) {
		throw new RangeError(messages.wrongLength(site, input, length));
	}
	return new Uint8Array(buffer, byteOffsetOf.call(value), byteLength);
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
