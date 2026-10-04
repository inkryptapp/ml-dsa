import { readFileSync } from "node:fs";
import { z } from "zod";

const Hex = z.string().regex(/^(?:[0-9A-F]{2})*$/, "upper-case hex of whole bytes, as ACVP writes it");

/**
 * The NIST ACVP ML-DSA-87 capture written by `scripts/fetch-acvp-vectors.mjs`. Only the fields the tests read are
 * parsed. Each group keeps its other upstream fields in the file.
 */
const Capture = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  keyGen: z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    groups: z.array(
      z.object({
        tgId: z.number(),
        parameterSet: z.literal("ML-DSA-87"),
        tests: z.array(z.object({ tcId: z.number(), seed: Hex, pk: Hex, sk: Hex })),
      }),
    ),
  }),
});

export const acvp = Capture.parse(
  JSON.parse(readFileSync(new URL("./vectors/acvp-ml-dsa-87.json", import.meta.url), "utf8")),
);

export const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
export const upperHex = (value: Uint8Array): string => Buffer.from(value).toString("hex").toUpperCase();
