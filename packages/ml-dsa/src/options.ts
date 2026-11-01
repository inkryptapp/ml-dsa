import * as messages from "./messages.js";
import type { Site } from "./messages.js";

/**
 * The read step of `sign` and `verify`. It runs the shape check, the
 * plain-object check, one `Reflect.ownKeys` with the unknown-key check over
 * every own key, then one read of each known key that the options hold as an
 * own property, in the order of `known`. It reads no property descriptors.
 *
 * After it returns, no caller code runs in the call: the input checks read
 * only the values that it returns. A known key that `Reflect.ownKeys` didn't
 * list reads as `undefined`, so a value inherited from a polluted
 * `Object.prototype` can't supply an option that the caller left out.
 *
 * @throws TypeError if the options aren't an object, if their prototype is
 * neither `Object.prototype` nor `null`, or if they hold any own key, symbols
 * and non-enumerable keys included, outside `known`.
 * @throws Whatever the caller's getters and proxy traps throw, unchanged, and
 * the engine's `TypeError` for an invalid trap result.
 */
export function readOptions<const Key extends string>(
	site: Site,
	options: unknown,
	known: readonly Key[],
): ReadonlyMap<Key, unknown> {
	if (typeof options !== "object") {
		throw new TypeError(messages.notOptionsObject(site, typeof options));
	}
	if (options === null) {
		throw new TypeError(messages.nullOptions(site));
	}
	const prototype = Reflect.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(messages.notPlainObject(site));
	}
	const ownKeys = Reflect.ownKeys(options);
	const isKnown = (key: string | symbol): key is Key => known.some((name) => name === key);
	for (const key of ownKeys) {
		if (!isKnown(key)) {
			throw new TypeError(messages.unknownOption(site, known));
		}
	}
	const values = new Map<Key, unknown>();
	for (const key of known) {
		if (ownKeys.includes(key)) {
			const value: unknown = Reflect.get(options, key);
			values.set(key, value);
		}
	}
	return values;
}
