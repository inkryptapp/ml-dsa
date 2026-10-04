import { describe, expect, test } from "vitest";
import { loadMlDsa87 } from "../src/index.js";
import { acvp, bytes, upperHex } from "./acvp.js";

const mlDsa = await loadMlDsa87();

interface Case {
  tgId: number;
  tcId: number;
  rnd: Uint8Array;
  entry: { message: string; sk: string; context: string; signature: string };
}

// Deterministic signing is signing with 32 zero bytes of Signing randomness.
const cases = acvp.sigGen.groups.flatMap((group): Case[] =>
  group.deterministic
    ? group.tests.map((entry) => ({ tgId: group.tgId, tcId: entry.tcId, rnd: new Uint8Array(32), entry }))
    : group.tests.map((entry) => ({ tgId: group.tgId, tcId: entry.tcId, rnd: bytes(entry.rnd), entry })),
);

describe("ACVP ML-DSA-87 sigGen, external interface, pure", () => {
  test("the capture holds the deterministic and the hedged group, 15 tests each", () => {
    expect(acvp.sigGen.groups.map((group) => [group.tgId, group.deterministic, group.tests.length])).toEqual([
      [5, true, 15],
      [17, false, 15],
    ]);
  });

  test.each(cases)("tgId $tgId tcId $tcId: the signature of its inputs", ({ rnd, entry }) => {
    const signature = mlDsa.sign({
      secretKey: bytes(entry.sk),
      message: bytes(entry.message),
      context: bytes(entry.context),
      rnd,
    });

    expect(upperHex(signature)).toBe(entry.signature);
  });
});

const withEmptyContext = cases.find(({ entry }) => entry.context === "");
if (withEmptyContext === undefined) {
  throw new Error("the capture has no sigGen test with an empty Context");
}

test("an omitted Context signs as the empty Context", () => {
  const { rnd, entry } = withEmptyContext;

  const signature = mlDsa.sign({ secretKey: bytes(entry.sk), message: bytes(entry.message), rnd });

  expect(upperHex(signature)).toBe(entry.signature);
});

// Callers may not be type-checked, so the wrong types arrive as they would from plain JavaScript.
const signUnchecked = (args: unknown) => mlDsa.sign(args as Parameters<typeof mlDsa.sign>[0]);
const validArgs = {
  secretKey: bytes(withEmptyContext.entry.sk),
  message: bytes(withEmptyContext.entry.message),
  context: new Uint8Array(0),
  rnd: withEmptyContext.rnd,
};

describe("sign rejects arguments it can't use", () => {
  test.each([
    ["no argument object", undefined],
    ["null", null],
    ["positional arguments", validArgs.secretKey],
  ])("TypeError for %s", (_name, args) => {
    expect(() => signUnchecked(args)).toThrow(TypeError);
  });

  test.each([
    ["secretKey", undefined],
    ["secretKey", Array.from(validArgs.secretKey)],
    ["message", undefined],
    ["message", "a message"],
    ["message", new Int8Array(validArgs.message)],
    ["context", "a context"],
    ["context", null],
    ["context", new ArrayBuffer(0)],
    ["rnd", undefined],
    ["rnd", new ArrayBuffer(32)],
  ])("TypeError for a %s of %o", (field, value) => {
    expect(() => signUnchecked({ ...validArgs, [field]: value })).toThrow(TypeError);
  });

  test.each([
    ["secretKey", 4895],
    ["secretKey", 4897],
    ["rnd", 31],
    ["rnd", 33],
    ["context", 256],
  ])("RangeError for a %s of %i bytes", (field, length) => {
    expect(() => signUnchecked({ ...validArgs, [field]: new Uint8Array(length) })).toThrow(RangeError);
  });
});
