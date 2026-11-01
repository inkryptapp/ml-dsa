import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { mlDsa44 } from "../src/index.js";
import { currentMemory, pointer, layout, setExportHook } from "../src/testing.js";
import {
	byteSource,
	freshMemoryMismatch,
	isAllZero,
	messageOf,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
	untypedFunction,
} from "./helpers.js";
import { countingProxy } from "./inputs.js";

afterEach(() => {
	setExportHook(null);
});

/** Runs `action` while `Object.prototype` holds `key`, and removes it afterwards. */
function withPollution<Result>(key: string, value: unknown, action: () => Result): Result {
	Reflect.defineProperty(Object.prototype, key, { configurable: true, writable: true, value });
	try {
		return action();
	} finally {
		Reflect.deleteProperty(Object.prototype, key);
	}
}

/**
 * A Proxy of a copy of `fields` whose `ownKeys` trap returns `[1]`, which the
 * engine rejects with its own `TypeError`. The trap's type forbids that
 * result, so the handler gets the trap through `Reflect.set`.
 */
function withInvalidOwnKeys(fields: object): object {
	const handler: ProxyHandler<object> = {};
	Reflect.set(handler, "ownKeys", () => [1]);
	return new Proxy({ ...fields }, handler);
}

for (const { objectName, object, noble } of parameterSetCases) {
	const signSite = `${objectName}.sign`;
	const bytes = byteSource(0x5eed_0030);
	const seed = seedFrom(50);
	const message = bytes(100);
	const context = bytes(33);
	const randomness = bytes(32);
	const { publicKey, secretKey } = noble.keygen(seed);
	const signature = noble.sign(message, secretKey, { context, extraEntropy: randomness });
	const signOptions = { seed, message, context, randomness };
	const verifyOptions = { publicKey, message, signature, context };
	const sign = untypedFunction(object, "sign");
	const verify = untypedFunction(object, "verify");

	/**
	 * Expects `sign(toSign)` to throw exactly `type` with `text`,
	 * `verify(toVerify)` to return `false`, the slot to keep its instance, and
	 * memory to stay fresh.
	 */
	function expectBothRejected(
		toSign: unknown,
		toVerify: unknown,
		type: object,
		text: string,
	): void {
		const before = currentMemory();
		const error = thrown(() => sign(toSign));
		expect(prototypeOf(error)).toBe(type);
		expect(error).toHaveProperty("message", text);
		expect(verify(toVerify)).toBe(false);
		expect(currentMemory()).toBe(before);
		expect(freshMemoryMismatch()).toBeNull();
	}

	describe(`the ${objectName} read step`, () => {
		test.each([
			["undefined", undefined, `typeof options is "undefined"`],
			["a number", 1, `typeof options is "number"`],
			["a string", "options", `typeof options is "string"`],
			["a function", () => signOptions, `typeof options is "function"`],
			["a symbol", Symbol("options"), `typeof options is "symbol"`],
		])("rejects options that are %s", (_, value, typeText) => {
			expectBothRejected(
				value,
				value,
				TypeError.prototype,
				`${signSite}: options must be an object, but ${typeText}.`,
			);
		});

		test("rejects null options", () => {
			expectBothRejected(
				null,
				null,
				TypeError.prototype,
				`${signSite}: options must be an object, not null.`,
			);
		});

		test("accepts options with a null prototype", () => {
			const signNull = Object.assign(Object.create(null), signOptions);
			const verifyNull = Object.assign(Object.create(null), verifyOptions);
			expect(sign(signNull)).toStrictEqual(signature);
			expect(verify(verifyNull)).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test.each([
			[
				"a class instance",
				(fields: object): object => Object.assign(new (class Options {})(), fields),
			],
			[
				"an object with a custom prototype",
				(fields: object): object => Object.assign(Object.create({}), fields),
			],
			["an array", (fields: object): object => Object.assign([], fields)],
			[
				"a plain object from another realm",
				(fields: object): object => Object.assign(runInNewContext("({})"), fields),
			],
		])("rejects options that are %s", (_, make) => {
			expectBothRejected(
				make(signOptions),
				make(verifyOptions),
				TypeError.prototype,
				`${signSite}: options must be a plain object, whose prototype is Object.prototype or null.`,
			);
		});

		test("rejects options whose custom prototype holds the context", () => {
			const { context: _, ...signRest } = signOptions;
			const { context: __, ...verifyRest } = verifyOptions;
			expectBothRejected(
				Object.assign(Object.create({ context }), signRest),
				Object.assign(Object.create({ context }), verifyRest),
				TypeError.prototype,
				`${signSite}: options must be a plain object, whose prototype is Object.prototype or null.`,
			);
		});

		test.each([
			["a misspelled key", (fields: object): object => ({ ...fields, ctx: context })],
			["a symbol key", (fields: object): object => ({ ...fields, [Symbol("context")]: context })],
			[
				"a non-enumerable key",
				(fields: object): object =>
					Object.defineProperty({ ...fields }, "extra", { value: 1, enumerable: false }),
			],
			["an undefined unknown key", (fields: object): object => ({ ...fields, extra: undefined })],
		])("rejects options with %s", (_, make) => {
			expectBothRejected(
				make(signOptions),
				make(verifyOptions),
				TypeError.prototype,
				`${signSite}: options may hold only these keys: seed, message, context, randomness.`,
			);
		});

		test("reads a non-enumerable own known key", () => {
			const { context: _, ...signRest } = signOptions;
			const hidden = Object.defineProperty({ ...signRest }, "context", {
				value: context,
				enumerable: false,
			});
			expect(sign(hidden)).toStrictEqual(signature);
			expect(freshMemoryMismatch()).toBeNull();
		});

		describe("with a polluted Object.prototype", () => {
			test("signs and verifies under the empty context when context isn't an own key", () => {
				const polluted = bytes(10);
				const empty = noble.sign(message, secretKey, { extraEntropy: randomness });
				const underPolluted = noble.sign(message, secretKey, {
					context: polluted,
					extraEntropy: randomness,
				});
				withPollution("context", polluted, () => {
					expect(object.sign({ seed, message, randomness })).toStrictEqual(empty);
					expect(object.verify({ publicKey, message, signature: empty })).toBe(true);
					expect(object.verify({ publicKey, message, signature: underPolluted })).toBe(false);
				});
				expect(freshMemoryMismatch()).toBeNull();
			});

			test.each(["seed", "message", "randomness"] as const)(
				"treats an inherited %s as missing",
				(key) => {
					const { [key]: value, ...rest } = signOptions;
					const error = withPollution(key, value, () => thrown(() => sign(rest)));
					expect(prototypeOf(error)).toBe(TypeError.prototype);
					expect(error).toHaveProperty("message", `${signSite}: ${key} is required.`);
					expect(freshMemoryMismatch()).toBeNull();
				},
			);
		});

		test("reads each known key once, in the order of the input checks", () => {
			const reads: string[] = [];
			const getters = (fields: Record<string, unknown>): object =>
				Object.defineProperties(
					{},
					Object.fromEntries(
						Object.entries(fields).map(([key, value]) => [
							key,
							{
								enumerable: true,
								get: (): unknown => {
									reads.push(key);
									return value;
								},
							},
						]),
					),
				);
			expect(sign(getters({ randomness, context, message, seed }))).toStrictEqual(signature);
			expect(reads).toStrictEqual(["seed", "message", "context", "randomness"]);
			reads.length = 0;
			expect(verify(getters({ context, signature, message, publicKey }))).toBe(true);
			expect(reads).toStrictEqual(["publicKey", "message", "signature", "context"]);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test.each([
			["an error of its own type", new (class CallerError extends Error {})("caller")],
			["a string", "caller"],
		])("lets a getter's exception of %s through unchanged", (_, thrownValue) => {
			const throwing = (fields: object): object =>
				Object.defineProperty({ ...fields }, "message", {
					enumerable: true,
					get: () => {
						throw thrownValue;
					},
				});
			const before = currentMemory();
			expect(thrown(() => sign(throwing(signOptions)))).toBe(thrownValue);
			expect(verify(throwing(verifyOptions))).toBe(false);
			expect(currentMemory()).toBe(before);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("runs exactly one getPrototypeOf, one ownKeys, and one get per known key on a Proxy", () => {
			const signProxy = countingProxy({ ...signOptions });
			expect(sign(signProxy.proxy)).toStrictEqual(signature);
			expect(Object.fromEntries(signProxy.counts)).toStrictEqual({
				getPrototypeOf: 1,
				ownKeys: 1,
				get: 4,
			});
			const verifyProxy = countingProxy({ ...verifyOptions });
			expect(verify(verifyProxy.proxy)).toBe(true);
			expect(Object.fromEntries(verifyProxy.counts)).toStrictEqual({
				getPrototypeOf: 1,
				ownKeys: 1,
				get: 4,
			});
			const { context: _, ...withoutContext } = signOptions;
			const partial = countingProxy(withoutContext);
			sign(partial.proxy);
			expect(partial.counts.get("get")).toBe(3);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("reads no value from a Proxy with an unknown key", () => {
			const { proxy, counts } = countingProxy({ ...signOptions, extra: 1 });
			const error = thrown(() => sign(proxy));
			expect(prototypeOf(error)).toBe(TypeError.prototype);
			expect(Object.fromEntries(counts)).toStrictEqual({ getPrototypeOf: 1, ownKeys: 1 });
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("lets a trap's exception and the engine's error for a bad trap result through", () => {
			const trapError = new RangeError("trap");
			const throwingTrap = new Proxy(
				{ ...signOptions },
				{
					ownKeys: () => {
						throw trapError;
					},
				},
			);
			expect(thrown(() => sign(throwingTrap))).toBe(trapError);
			const engineError = thrown(() => sign(withInvalidOwnKeys(signOptions)));
			expect(prototypeOf(engineError)).toBe(TypeError.prototype);
			expect(messageOf(engineError)).not.toContain(signSite);
			expect(verify(withInvalidOwnKeys(verifyOptions))).toBe(false);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("rejects a Proxy whose getPrototypeOf trap reports another prototype", () => {
			const proxy = new Proxy({ ...signOptions }, { getPrototypeOf: () => Array.prototype });
			expectBothRejected(
				proxy,
				new Proxy({ ...verifyOptions }, { getPrototypeOf: () => Array.prototype }),
				TypeError.prototype,
				`${signSite}: options must be a plain object, whose prototype is Object.prototype or null.`,
			);
		});
	});

	describe(`a getter that calls the package during the ${objectName} read step`, () => {
		/** Options whose `message` getter runs `nested` first. */
		function nestedIn<Fields extends object>(fields: Fields, nested: () => void): Fields {
			return Object.defineProperty({ ...fields }, "message", {
				enumerable: true,
				get: () => {
					nested();
					return message;
				},
			});
		}

		test("runs a nested sign, and the outer result stays correct", () => {
			let inner: unknown = undefined;
			const nested = (): void => {
				inner = object.sign({ ...signOptions, context: undefined });
			};
			expect(sign(nestedIn(signOptions, nested))).toStrictEqual(signature);
			expect(inner).toStrictEqual(noble.sign(message, secretKey, { extraEntropy: randomness }));
			expect(verify(nestedIn(verifyOptions, nested))).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("runs a nested verify, and the outer result stays correct", () => {
			let inner: unknown = undefined;
			const nested = (): void => {
				inner = object.verify(verifyOptions);
			};
			expect(sign(nestedIn(signOptions, nested))).toStrictEqual(signature);
			expect(inner).toBe(true);
			expect(verify(nestedIn(verifyOptions, nested))).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("runs a nested call that traps and replaces the instance, and the outer result stays correct", () => {
			const replaced: (Uint8Array | null)[] = [];
			const nested = (): void => {
				const before = currentMemory();
				setExportHook((call) => {
					call.functions.mldsa_shake256_init(pointer(layout.memoryBytes));
					return call.proceed();
				});
				const error = thrown(() => mlDsa44.keygen(seed));
				setExportHook(null);
				expect(prototypeOf(error)).toBe(Error.prototype);
				expect(currentMemory()).toBeNull();
				replaced.push(before);
			};
			expect(sign(nestedIn(signOptions, nested))).toStrictEqual(signature);
			expect(verify(nestedIn(verifyOptions, nested))).toBe(true);
			expect(replaced).toHaveLength(2);
			expect(replaced.every((memory) => memory !== null && isAllZero(memory))).toBe(true);
			expect(freshMemoryMismatch()).toBeNull();
		});
	});
}
