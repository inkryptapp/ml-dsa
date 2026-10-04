import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { loadMlDsa87 } from "../src/index.js";
import { acvp, bytes } from "./acvp.js";

const mlDsa = await loadMlDsa87();

const cases = acvp.sigVer.groups.flatMap((group) =>
  group.tests.map((entry) => ({ tgId: group.tgId, tcId: entry.tcId, entry })),
);

describe("ACVP ML-DSA-87 sigVer, external interface, pure", () => {
  test("the capture holds one group of 15 tests, 3 of them valid", () => {
    expect(cases.map(({ tgId, tcId, entry }) => [tgId, tcId, entry.testPassed])).toEqual(
      Array.from({ length: 15 }, (_, index) => [5, 61 + index, [63, 67, 70].includes(61 + index)]),
    );
  });

  test.each(cases)("tgId $tgId tcId $tcId: $entry.reason", ({ entry }) => {
    const result = mlDsa.verify({
      publicKey: bytes(entry.pk),
      message: bytes(entry.message),
      context: bytes(entry.context),
      signature: bytes(entry.signature),
    });

    expect(result).toBe(entry.testPassed);
  });
});

const [accepted] = cases.filter(({ entry }) => entry.testPassed).map(({ entry }) => entry);
if (accepted === undefined) throw new Error("the capture has no valid sigVer test");
const validArgs = {
  publicKey: bytes(accepted.pk),
  message: bytes(accepted.message),
  context: bytes(accepted.context),
  signature: bytes(accepted.signature),
};

test("a valid signature does not verify under another Context, or under none", () => {
  const { context: _context, ...withoutContext } = validArgs;

  expect([
    mlDsa.verify(validArgs),
    mlDsa.verify({ ...validArgs, context: new Uint8Array(0) }),
    mlDsa.verify(withoutContext),
  ]).toEqual([true, false, false]);
});

// Callers may not be type-checked, so the wrong types arrive as they would from plain JavaScript.
const verifyUnchecked = (args: unknown) => mlDsa.verify(args as Parameters<typeof mlDsa.verify>[0]);

describe("verify answers false, without throwing, for arguments it can't use", () => {
  test.each([
    ["no argument object", undefined],
    ["null", null],
    ["positional arguments", validArgs.signature],
    [
      "an object whose getter throws",
      {
        get publicKey(): never {
          throw new Error("hostile");
        },
      },
    ],
  ])("%s", (_name, args) => {
    expect(verifyUnchecked(args)).toBe(false);
  });

  test.each([
    ["publicKey", undefined],
    ["publicKey", Array.from(validArgs.publicKey)],
    ["message", undefined],
    ["message", Buffer.from(validArgs.message).toString("latin1")],
    ["message", new Int8Array(validArgs.message)],
    ["context", Buffer.from(validArgs.context).toString("latin1")],
    ["context", null],
    ["signature", validArgs.signature.buffer],
    ["signature", Array.from(validArgs.signature)],
  ])("a %s of %o", (field, value) => {
    expect(verifyUnchecked({ ...validArgs, [field]: value })).toBe(false);
  });

  test.each([
    ["publicKey", 2591, validArgs.publicKey.subarray(1)],
    ["publicKey", 2593, Uint8Array.of(...validArgs.publicKey, 0)],
    ["signature", 4626, validArgs.signature.subarray(0, -1)],
    ["signature", 4628, Uint8Array.of(...validArgs.signature, 0)],
    ["context", 256, new Uint8Array(256)],
  ])("a %s of %i bytes", (field, _length, value) => {
    expect(verifyUnchecked({ ...validArgs, [field]: value })).toBe(false);
  });

  // A short signature must not verify against the rest of an earlier signature still in memory.
  test("a truncated signature after verifying the whole one", () => {
    expect([
      mlDsa.verify(validArgs),
      mlDsa.verify({ ...validArgs, signature: validArgs.signature.subarray(0, -1) }),
    ]).toEqual([true, false]);
  });
});

/** Appendix E's test case, captured from the draft text. The file records the source URL and the draft's SHA-256. */
const Composite = z.object({
  source: z.literal("https://www.ietf.org/archive/id/draft-ietf-lamps-pq-composite-sigs-19.txt"),
  sha256: z.literal("b4ee04416efc26e7d8de7c740dc3848ffe8b8cc9dcd035ad9d4e33e18844ec83"),
  m: z.base64(),
  ctx: z.base64(),
  test: z.object({
    tcId: z.literal("id-MLDSA87-ECDSA-P384-SHA512"),
    pk: z.base64(),
    s: z.base64(),
    sWithContext: z.base64(),
  }),
});

const draft = Composite.parse(
  JSON.parse(readFileSync(new URL("./vectors/composite-mldsa87-p384.json", import.meta.url), "utf8")),
);
const base64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const ascii = (text: string) => new Uint8Array(Buffer.from(text, "ascii"));
const label = ascii("COMPSIG-MLDSA87-ECDSA-P384-SHA512");

/** The draft's message representative: M' = Prefix || Label || len(ctx) || ctx || SHA-512(M). */
function representative(message: Uint8Array, context: Uint8Array): Uint8Array {
  return Buffer.concat([
    ascii("CompositeAlgorithmSignatures2025"),
    label,
    Uint8Array.of(context.length),
    context,
    createHash("sha512").update(message).digest(),
  ]);
}

describe("draft-ietf-lamps-pq-composite-sigs-19, id-MLDSA87-ECDSA-P384-SHA512", () => {
  // The composite Public key and signature each start with their ML-DSA half, which signs M' under the Label.
  const publicKey = base64(draft.test.pk).subarray(0, 2592);
  const message = base64(draft.m);
  const context = base64(draft.ctx);

  test.each([
    ["the empty ctx", draft.test.s, new Uint8Array(0)],
    ["the draft's ctx", draft.test.sWithContext, context],
  ])("the ML-DSA half of the signature under %s verifies under the Label", (_name, s, ctx) => {
    const signature = base64(s).subarray(0, 4627);

    expect([
      mlDsa.verify({ publicKey, message: representative(message, ctx), context: label, signature }),
      mlDsa.verify({ publicKey, message: representative(message, ctx), signature }),
      mlDsa.verify({
        publicKey,
        message: representative(Uint8Array.of(...message, 0), ctx),
        context: label,
        signature,
      }),
    ]).toEqual([true, false, false]);
  });
});
