import { describe, expect, expectTypeOf, test } from "vite-plus/test";

import * as entry from "../src/index.js";
import { mlDsa44, mlDsa65, mlDsa87 } from "../src/index.js";
import {
	freshMemoryMismatch,
	parameterSetCases,
	prototypeOf,
	seedFrom,
	thrown,
	untypedFunction,
} from "./helpers.js";

test("the default entry exports exactly the three objects", () => {
	expect(Object.keys(entry).toSorted()).toStrictEqual(["mlDsa44", "mlDsa65", "mlDsa87"]);
});

test("each object names its parameter set and holds the FIPS 204 lengths", () => {
	expect(
		parameterSetCases.map(({ object }) => [object.parameterSet, { ...object.lengths }]),
	).toStrictEqual([
		["ML-DSA-44", { seed: 32, randomness: 32, publicKey: 1312, signature: 2420, maxContext: 255 }],
		["ML-DSA-65", { seed: 32, randomness: 32, publicKey: 1952, signature: 3309, maxContext: 255 }],
		["ML-DSA-87", { seed: 32, randomness: 32, publicKey: 2592, signature: 4627, maxContext: 255 }],
	]);
});

test("the lengths have literal types", () => {
	expectTypeOf(mlDsa44.lengths.publicKey).toEqualTypeOf<1312>();
	expectTypeOf(mlDsa44.lengths.signature).toEqualTypeOf<2420>();
	expectTypeOf(mlDsa65.lengths.publicKey).toEqualTypeOf<1952>();
	expectTypeOf(mlDsa65.lengths.signature).toEqualTypeOf<3309>();
	expectTypeOf(mlDsa87.lengths.publicKey).toEqualTypeOf<2592>();
	expectTypeOf(mlDsa87.lengths.signature).toEqualTypeOf<4627>();
	expectTypeOf(mlDsa87.lengths.seed).toEqualTypeOf<32>();
	expectTypeOf(mlDsa87.lengths.randomness).toEqualTypeOf<32>();
	expectTypeOf(mlDsa87.lengths.maxContext).toEqualTypeOf<255>();
	expectTypeOf(mlDsa87.parameterSet).toEqualTypeOf<"ML-DSA-87">();
});

describe.each(parameterSetCases)("the $objectName object", ({ objectName, object, noble }) => {
	test("has exactly its five own keys, Object.prototype as its prototype, and is frozen", () => {
		expect(Reflect.ownKeys(object)).toStrictEqual([
			"parameterSet",
			"lengths",
			"keygen",
			"sign",
			"verify",
		]);
		expect(prototypeOf(object)).toBe(Object.prototype);
		expect(Object.isFrozen(object)).toBe(true);
	});

	test("has frozen lengths with exactly their five own keys", () => {
		expect(Reflect.ownKeys(object.lengths)).toStrictEqual([
			"seed",
			"randomness",
			"publicKey",
			"signature",
			"maxContext",
		]);
		expect(prototypeOf(object.lengths)).toBe(Object.prototype);
		expect(Object.isFrozen(object.lengths)).toBe(true);
	});

	test("agrees with noble on the seed, public key, and signature lengths", () => {
		expect(object.lengths.publicKey).toBe(noble.lengths.publicKey);
		expect(object.lengths.signature).toBe(noble.lengths.signature);
		expect(object.lengths.seed).toBe(noble.lengths.seed);
	});

	test.each(["keygen", "sign", "verify"] as const)(
		"has a frozen %s function whose own keys are exactly length and name",
		(operation) => {
			const operationFunction = object[operation];
			expect(Reflect.ownKeys(operationFunction)).toStrictEqual(["length", "name"]);
			expect(operationFunction.name).toBe(operation);
			expect(operationFunction.length).toBe(1);
			expect(Object.isFrozen(operationFunction)).toBe(true);
		},
	);

	test("refuses a write to the object, its lengths, or a function", () => {
		expect(Reflect.set(object, "keygen", () => undefined)).toBe(false);
		expect(Reflect.set(object.lengths, "seed", 64)).toBe(false);
		expect(Reflect.set(object.keygen, "extra", 1)).toBe(false);
	});

	test.each(["sign", "verify"] as const)(
		"%s throws a plain Error until it is implemented",
		(operation) => {
			const error = thrown(() => untypedFunction(object, operation)({ seed: seedFrom(0) }));
			expect(prototypeOf(error)).toBe(Error.prototype);
			expect(error).toHaveProperty(
				"message",
				`${objectName}.${operation}: the operation is not implemented yet.`,
			);
			expect(freshMemoryMismatch()).toBeNull();
		},
	);
});
