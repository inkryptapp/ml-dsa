import { Buffer } from "node:buffer";

import { describe, expect, test } from "vite-plus/test";

import {
	byteSource,
	freshMemoryMismatch,
	messageOf,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
	untypedFunction,
} from "./helpers.js";
import {
	acceptedForms,
	badBackings,
	countingProxy,
	LengthLiar,
	watchedReads,
	wrongTypes,
} from "./inputs.js";

const keys = ["seed", "message", "context", "randomness"] as const;

for (const { objectName, object, noble } of parameterSetCases) {
	const site = `${objectName}.sign`;
	const bytes = byteSource(0x5eed_0010);
	const seed = seedFrom(40);
	const message = bytes(385);
	const context = bytes(33);
	const randomness = bytes(32);
	const valid = { seed, message, context, randomness };
	const { secretKey } = noble.keygen(seed);
	const reference = noble.sign(message, secretKey, { context, extraEntropy: randomness });
	const sign = untypedFunction(object, "sign");

	/** Expects `sign(options)` to throw exactly `type` with `text`, and memory to stay fresh. */
	function expectRejected(options: unknown, type: object, text: string): void {
		const error = thrown(() => sign(options));
		expect(prototypeOf(error)).toBe(type);
		expect(error).toHaveProperty("message", text);
		expect(freshMemoryMismatch()).toBeNull();
	}

	const typeMessage = (key: string, type: string): string => {
		const allowed = key === "randomness" ? 'a Uint8Array or "deterministic"' : "a Uint8Array";
		return `${site}: ${key} must be ${allowed}, but typeof ${key} is "${type}".`;
	};

	const backingMessage = (key: string): string =>
		key === "seed" || key === "randomness"
			? `${site}: ${key} must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as new Uint8Array(new ArrayBuffer(32)) filled with set.`
			: `${site}: ${key} must be backed by a fixed-length, non-shared, non-detached ArrayBuffer, such as the copy that new Uint8Array(${key}) makes.`;

	describe(site, () => {
		test("gives noble's deterministic signature over a short message", () => {
			const short = new Uint8Array([1, 2, 3]);
			const expected = noble.sign(short, secretKey, { extraEntropy: false });
			expect(object.sign({ seed, message: short, randomness: "deterministic" })).toStrictEqual(
				expected,
			);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("gives noble's hedged signature under a context string", () => {
			expect(object.sign(valid)).toStrictEqual(reference);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("signs under the empty context string when context is missing or undefined", () => {
			const expected = noble.sign(message, secretKey, { extraEntropy: randomness });
			expect(object.sign({ seed, message, randomness })).toStrictEqual(expected);
			expect(object.sign({ seed, message, randomness, context: undefined })).toStrictEqual(
				expected,
			);
			expect(object.sign({ ...valid, context: new Uint8Array(0) })).toStrictEqual(expected);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test("returns a new array that owns a fixed-length buffer of its own", () => {
			const first = object.sign(valid);
			const second = object.sign(valid);
			expect(prototypeOf(first)).toBe(Uint8Array.prototype);
			expect(first.byteOffset).toBe(0);
			expect(first.buffer.byteLength).toBe(object.lengths.signature);
			expect(first.buffer.resizable).toBe(false);
			expect(first.buffer).not.toBe(second.buffer);
			first.fill(0);
			expect(object.sign(valid)).toStrictEqual(second);
			expect(freshMemoryMismatch()).toBeNull();
		});

		test.each(keys)(
			"reads exactly the own bytes of %s, whatever its realm, class, or own properties",
			(key) => {
				const before = { ...watchedReads };
				for (const [, form] of acceptedForms(valid[key])) {
					expect(sign({ ...valid, [key]: form })).toStrictEqual(reference);
					expect(freshMemoryMismatch()).toBeNull();
				}
				expect(watchedReads).toStrictEqual(before);
			},
		);

		test.each(["seed", "message", "randomness"] as const)(
			"throws TypeError for a missing %s",
			(key) => {
				const { [key]: _, ...rest } = valid;
				expectRejected(rest, TypeError.prototype, `${site}: ${key} is required.`);
				expectRejected(
					{ ...rest, [key]: undefined },
					TypeError.prototype,
					`${site}: ${key} is required.`,
				);
			},
		);

		test.each(keys)("throws TypeError for each wrong type of %s", (key) => {
			for (const [, value, type] of wrongTypes(valid[key])) {
				expectRejected({ ...valid, [key]: value }, TypeError.prototype, typeMessage(key, type));
			}
		});

		test.each(keys)(
			"throws TypeError for a Proxy of a Uint8Array as %s, and runs none of its traps",
			(key) => {
				const { proxy, counts } = countingProxy(new Uint8Array(valid[key]));
				expectRejected({ ...valid, [key]: proxy }, TypeError.prototype, typeMessage(key, "object"));
				expect(Object.fromEntries(counts)).toStrictEqual({});
			},
		);

		test("throws TypeError for any string as randomness other than deterministic", () => {
			for (const value of ["Deterministic", "deterministic ", "", "hedged"]) {
				expectRejected(
					{ ...valid, randomness: value },
					TypeError.prototype,
					typeMessage("randomness", "string"),
				);
			}
		});

		test.each(keys)("throws TypeError for %s on a shared, resizable, or detached buffer", (key) => {
			for (const [, value] of badBackings(valid[key])) {
				expectRejected({ ...valid, [key]: value }, TypeError.prototype, backingMessage(key));
			}
		});

		test.each(["seed", "randomness"] as const)(
			"throws RangeError for %s that isn't 32 bytes long",
			(key) => {
				const text = `${site}: ${key} must be 32 bytes long.`;
				for (const length of [0, 1, 31, 33, 64]) {
					expectRejected(
						{ ...valid, [key]: new Uint8Array(new ArrayBuffer(length)).fill(1) },
						RangeError.prototype,
						text,
					);
				}
				const short = new Uint8Array(new ArrayBuffer(31)).fill(1);
				Object.defineProperty(short, "length", { value: 32 });
				expectRejected({ ...valid, [key]: short }, RangeError.prototype, text);
				expectRejected({ ...valid, [key]: new LengthLiar(31).fill(1) }, RangeError.prototype, text);
			},
		);

		test("accepts a context of 255 bytes and throws RangeError for a longer one", () => {
			const longest = bytes(255);
			expect(object.sign({ ...valid, context: longest })).toStrictEqual(
				noble.sign(message, secretKey, { context: longest, extraEntropy: randomness }),
			);
			for (const length of [256, 300, 65_536]) {
				expectRejected(
					{ ...valid, context: bytes(length) },
					RangeError.prototype,
					`${site}: context must be at most 255 bytes long, but it is ${length} bytes long.`,
				);
			}
		});

		test("throws RangeError for an all-zero seed or all-zero randomness", () => {
			const zero = new Uint8Array(new ArrayBuffer(32));
			expectRejected(
				{ ...valid, seed: zero },
				RangeError.prototype,
				`${site}: seed must not be all zeros.`,
			);
			expectRejected(
				{ ...valid, randomness: zero },
				RangeError.prototype,
				`${site}: randomness must not be all zeros. Pass "deterministic" for the deterministic variant.`,
			);
		});

		test("runs the checks in the documented order", () => {
			const zero = new Uint8Array(new ArrayBuffer(32));
			const shortShared = new Uint8Array(new SharedArrayBuffer(31));
			const cases: readonly (readonly [string, unknown, object, string])[] = [
				[
					"the options' type first",
					undefined,
					TypeError.prototype,
					`${site}: options must be an object, but typeof options is "undefined".`,
				],
				[
					"the prototype before the keys",
					Object.assign(Object.create({}), { ...valid, extra: 1 }),
					TypeError.prototype,
					`${site}: options must be a plain object, whose prototype is Object.prototype or null.`,
				],
				[
					"an unknown key before the inputs",
					{ ...valid, seed: 1, extra: 1 },
					TypeError.prototype,
					`${site}: options may hold only these keys: seed, message, context, randomness.`,
				],
				[
					"seed before message",
					{ ...valid, seed: 1, message: 1 },
					TypeError.prototype,
					`${site}: seed must be a Uint8Array, but typeof seed is "number".`,
				],
				[
					"message before context",
					{ ...valid, message: 1, context: 1 },
					TypeError.prototype,
					`${site}: message must be a Uint8Array, but typeof message is "number".`,
				],
				[
					"context before randomness",
					{ ...valid, context: bytes(256), randomness: 1 },
					RangeError.prototype,
					`${site}: context must be at most 255 bytes long, but it is 256 bytes long.`,
				],
				[
					"an input's backing before its length",
					{ ...valid, seed: shortShared },
					TypeError.prototype,
					backingMessage("seed"),
				],
				[
					"the input checks before the zero checks",
					{ ...valid, seed: zero, randomness: bytes(31) },
					RangeError.prototype,
					`${site}: randomness must be 32 bytes long.`,
				],
				[
					"the seed's zero check before the randomness's",
					{ ...valid, seed: zero, randomness: zero },
					RangeError.prototype,
					`${site}: seed must not be all zeros.`,
				],
			];
			for (const [, options, type, text] of cases) {
				expectRejected(options, type, text);
			}
		});

		test("throws no message that holds an input's bytes", () => {
			const distinct = {
				seed: bytes(31),
				message: bytes(64),
				context: bytes(256),
				randomness: bytes(33),
			};
			const failing = [
				{ ...valid, seed: distinct.seed },
				{ ...valid, context: distinct.context },
				{ ...valid, randomness: distinct.randomness },
				{ ...valid, message: Array.from(distinct.message) },
				{ ...valid, seed: Array.from(distinct.seed) },
			];
			const forms = (input: Uint8Array): readonly string[] => [
				Buffer.from(input).toString("hex"),
				Buffer.from(input).toString("base64"),
				Array.from(input).join(","),
				Array.from(input).join(", "),
			];
			const inputForms = Object.values(distinct).flatMap(forms);
			for (const options of failing) {
				const error = thrown(() => sign(options));
				const text = messageOf(error);
				expect(text).toMatch(new RegExp(`^${site.replace(".", "\\.")}: `));
				for (const form of inputForms) {
					expect(text).not.toContain(form);
				}
			}
		});
	});
}
