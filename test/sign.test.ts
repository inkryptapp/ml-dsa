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
