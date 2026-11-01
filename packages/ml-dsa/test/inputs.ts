import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";

/** A copy of `bytes` in a `Uint8Array` of another realm. */
export function fromAnotherRealm(bytes: Uint8Array): unknown {
	return runInNewContext("(bytes) => new Uint8Array(bytes)")(Array.from(bytes));
}

export class Subclass extends Uint8Array {}

// TypeScript declares `length` and `byteOffset` as properties, so a class
// can't override them with accessors, and the tests define the getters here.
export class LengthLiar extends Uint8Array {}
Object.defineProperty(LengthLiar.prototype, "length", { get: () => 32 });

export class ByteOffsetLiar extends Uint8Array {}
Object.defineProperty(ByteOffsetLiar.prototype, "byteOffset", { get: () => 7 });

/**
 * How often anything read the `Symbol.species` getter or the own `constructor`
 * getter of an accepted form. A method call on the array, such as `subarray`,
 * reads them.
 */
export const watchedReads = { species: 0, constructor: 0 };

class SpeciesWatcher extends Uint8Array {
	static get [Symbol.species](): Uint8ArrayConstructor {
		watchedReads.species += 1;
		return Uint8Array;
	}
}

/**
 * Forms of `bytes` that every byte input accepts as exactly those bytes,
 * whatever their realm, class, or own properties. Each form is a new array.
 */
export function acceptedForms(bytes: Uint8Array): readonly (readonly [string, unknown])[] {
	const offsetBuffer = new Uint8Array(new ArrayBuffer(bytes.length + 32));
	offsetBuffer.set(bytes, 16);
	const withOwnLength = new Uint8Array(bytes);
	Object.defineProperty(withOwnLength, "length", { value: bytes.length + 1 });
	const withOwnByteOffset = new Uint8Array(bytes);
	Object.defineProperty(withOwnByteOffset, "byteOffset", { value: 7 });
	const withConstructorGetter = new Uint8Array(bytes);
	Object.defineProperty(withConstructorGetter, "constructor", {
		get: () => {
			watchedReads.constructor += 1;
			return Uint8Array;
		},
	});
	return [
		["a Buffer", Buffer.from(bytes)],
		["a subclass", new Subclass(bytes)],
		["a subclass with a length getter", new LengthLiar(bytes)],
		["a subclass with a byteOffset getter", new ByteOffsetLiar(bytes)],
		["a subclass with a Symbol.species getter", new SpeciesWatcher(bytes)],
		["an array with an own length", withOwnLength],
		["an array with an own byteOffset", withOwnByteOffset],
		["an array with an own constructor getter", withConstructorGetter],
		["a view at an offset", new Uint8Array(offsetBuffer.buffer, 16, bytes.length)],
		["an array from another realm", fromAnotherRealm(bytes)],
	];
}

/** Values of the wrong type for a byte input, with what `typeof` reports for each. */
export function wrongTypes(bytes: Uint8Array): readonly (readonly [string, unknown, string])[] {
	return [
		["null", null, "object"],
		["a number", 32, "number"],
		["a string", "x".repeat(bytes.length), "string"],
		["an array of numbers", Array.from(bytes), "object"],
		["an ArrayBuffer", new Uint8Array(bytes).buffer, "object"],
		["a DataView", new DataView(new Uint8Array(bytes).buffer), "object"],
		["a Uint8ClampedArray", new Uint8ClampedArray(bytes), "object"],
		["an Int8Array", new Int8Array(bytes), "object"],
		["a Uint16Array", new Uint16Array(bytes.length).fill(1), "object"],
		["an array-like object", { length: bytes.length, 0: 1 }, "object"],
		["a Proxy of a Uint8Array", new Proxy(new Uint8Array(bytes), {}), "object"],
		["a function", () => bytes, "function"],
	];
}

/** Copies of `bytes` that sit on a shared, resizable, or detached buffer. */
export function badBackings(bytes: Uint8Array): readonly (readonly [string, Uint8Array])[] {
	const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
	shared.set(bytes);
	const resizable = new Uint8Array(
		new ArrayBuffer(bytes.length, { maxByteLength: bytes.length + 64 }),
	);
	resizable.set(bytes);
	const fixedViewOfResizable = new Uint8Array(
		new ArrayBuffer(bytes.length, { maxByteLength: bytes.length + 64 }),
		0,
		bytes.length,
	);
	fixedViewOfResizable.set(bytes);
	const detached = new Uint8Array(bytes);
	detached.buffer.transfer();
	return [
		["a shared buffer", shared],
		["a resizable buffer", resizable],
		["a fixed-length view of a resizable buffer", fixedViewOfResizable],
		["a detached buffer", detached],
	];
}

/**
 * A Proxy of `target` whose handler forwards every trap to `Reflect`, and the
 * count of calls to each trap, keyed by the trap's name.
 */
export function countingProxy<Target extends object>(
	target: Target,
): { readonly proxy: Target; readonly counts: Map<string, number> } {
	const counts = new Map<string, number>();
	const handler: ProxyHandler<Target> = {};
	for (const trap of [
		"apply",
		"construct",
		"defineProperty",
		"deleteProperty",
		"get",
		"getOwnPropertyDescriptor",
		"getPrototypeOf",
		"has",
		"isExtensible",
		"ownKeys",
		"preventExtensions",
		"set",
		"setPrototypeOf",
	] as const) {
		Reflect.set(handler, trap, (...args: readonly unknown[]): unknown => {
			counts.set(trap, (counts.get(trap) ?? 0) + 1);
			return Reflect.apply(Reflect.get(Reflect, trap), Reflect, args);
		});
	}
	return { proxy: new Proxy(target, handler), counts };
}
