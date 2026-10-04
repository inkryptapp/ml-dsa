import { describe, expect, test } from "vitest";
import {
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SECRET_KEY_BYTES,
  ML_DSA_87_SEED_BYTES,
  loadMlDsa87,
} from "../src/index.js";
import { acvp, bytes, upperHex } from "./acvp.js";

const mlDsa = await loadMlDsa87();

const cases = acvp.keyGen.groups.flatMap((group) =>
  group.tests.map((entry) => [group.tgId, entry.tcId, entry] as const),
);

describe("ACVP ML-DSA-87 keyGen", () => {
  test("the capture holds every keyGen test of the ML-DSA-87 group", () => {
    expect(cases.map(([tgId, tcId]) => [tgId, tcId])).toEqual(
      Array.from({ length: 25 }, (_, index) => [3, 51 + index]),
    );
  });

  test.each(cases)("tgId %i tcId %i: the key pair of its Seed", (_tgId, _tcId, entry) => {
    const { publicKey, secretKey } = mlDsa.keygen(bytes(entry.seed));

    expect(upperHex(publicKey)).toBe(entry.pk);
    expect(upperHex(secretKey)).toBe(entry.sk);
  });
});

test("a later keygen leaves an earlier key pair unchanged", () => {
  const [first, second] = cases.map(([, , entry]) => entry);
  if (first === undefined || second === undefined) throw new Error("the capture has fewer than two tests");

  const earlier = mlDsa.keygen(bytes(first.seed));
  mlDsa.keygen(bytes(second.seed));

  expect([earlier.publicKey.length, earlier.secretKey.length]).toEqual([2592, 4896]);
  expect(upperHex(earlier.publicKey)).toBe(first.pk);
  expect(upperHex(earlier.secretKey)).toBe(first.sk);
});

test("the byte lengths are FIPS 204's for ML-DSA-87", () => {
  expect([ML_DSA_87_PUBLIC_KEY_BYTES, ML_DSA_87_SECRET_KEY_BYTES, ML_DSA_87_SEED_BYTES]).toEqual([
    2592, 4896, 32,
  ]);
});

// Callers may not be type-checked, so the wrong types arrive as they would from plain JavaScript.
const keygenUnchecked = (seed: unknown) => mlDsa.keygen(seed as Uint8Array);

describe("keygen rejects a Seed it can't use", () => {
  test.each([
    ["undefined", undefined],
    ["a string", "0".repeat(32)],
    ["an ArrayBuffer", new ArrayBuffer(32)],
    ["a plain array", Array.from({ length: 32 }, () => 0)],
  ])("TypeError for %s", (_name, seed) => {
    expect(() => keygenUnchecked(seed)).toThrow(TypeError);
  });

  test.each([31, 33])("RangeError for a %i-byte Seed", (length) => {
    expect(() => mlDsa.keygen(new Uint8Array(length))).toThrow(RangeError);
  });
});
