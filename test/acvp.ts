import { z } from "zod";
import capture from "./vectors/acvp-ml-dsa-87.json" with { type: "json" };

const Hex = z.string().regex(/^(?:[0-9A-F]{2})*$/, "upper-case hex of whole bytes, as ACVP writes it");

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** A sigGen or sigVer group with the fields `scripts/fetch-acvp-vectors.mjs` selects on, so other groups fail to parse. */
const ExternalPure87Group = z.object({
  tgId: z.number(),
  parameterSet: z.literal("ML-DSA-87"),
  signatureInterface: z.literal("external"),
  preHash: z.literal("pure"),
  externalMu: z.literal(false),
});

const DeterministicSigGenTest = z.object({
  tcId: z.number(),
  message: Hex,
  sk: Hex,
  context: Hex,
  signature: Hex,
});

/**
 * The NIST ACVP ML-DSA-87 capture written by `scripts/fetch-acvp-vectors.mjs`. Only the fields the tests read are
 * parsed. Each group keeps its other upstream fields in the file.
 */
const Capture = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  keyGen: z.object({
    sha256: Sha256,
    groups: z.array(
      z.object({
        tgId: z.number(),
        parameterSet: z.literal("ML-DSA-87"),
        tests: z.array(z.object({ tcId: z.number(), seed: Hex, pk: Hex, sk: Hex })),
      }),
    ),
  }),
  sigGen: z.object({
    sha256: Sha256,
    groups: z.array(
      z.discriminatedUnion("deterministic", [
        ExternalPure87Group.extend({
          deterministic: z.literal(true),
          tests: z.array(DeterministicSigGenTest),
        }),
        ExternalPure87Group.extend({
          deterministic: z.literal(false),
          tests: z.array(DeterministicSigGenTest.extend({ rnd: Hex })),
        }),
      ]),
    ),
  }),
  sigVer: z.object({
    sha256: Sha256,
    groups: z.array(
      ExternalPure87Group.extend({
        tests: z.array(
          z.object({
            tcId: z.number(),
            testPassed: z.boolean(),
            reason: z.string(),
            pk: Hex,
            message: Hex,
            context: Hex,
            signature: Hex,
          }),
        ),
      }),
    ),
  }),
});

export const acvp = Capture.parse(capture);

// Hex by hand rather than through `Buffer`, so the tests also run in browsers.
export const bytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
export const upperHex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
