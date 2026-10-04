import { ml_dsa87 as oracle } from "@noble/post-quantum/ml-dsa.js";
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { type MlDsa87SignArgs, type MlDsa87VerifyArgs, loadMlDsa87 } from "../src/index.js";
import { upperHex } from "./acvp.js";

const mlDsa = await loadMlDsa87();

const seeds = fc.uint8Array({ minLength: 32, maxLength: 32 });
// Without `size: "max"`, fast-check keeps arrays to about 10 bytes. The edges are forced, not left to its bias.
const messages = fc.oneof(fc.uint8Array({ maxLength: 4096, size: "max" }), fc.constant(new Uint8Array(0)));
const contexts = fc.oneof(
  fc.uint8Array({ maxLength: 255, size: "max" }),
  fc.constant(new Uint8Array(0)),
  fc.uint8Array({ minLength: 255, maxLength: 255 }),
);
// 32 zero bytes is Deterministic signing.
const rnds = fc.oneof(seeds, fc.constant(new Uint8Array(32)));

type Signer = "ours" | "the Oracle";
const signers = fc.constantFrom<Signer>("ours", "the Oracle");

function signWith(who: Signer, args: Required<MlDsa87SignArgs>): Uint8Array {
  return who === "ours"
    ? mlDsa.sign(args)
    : oracle.sign(args.message, args.secretKey, { context: args.context, extraEntropy: args.rnd });
}

/** The Oracle's answer, where its RangeError for a Context over 255 bytes or a wrong-length Public key means false. */
function oracleVerify({ publicKey, message, context, signature }: Required<MlDsa87VerifyArgs>): boolean {
  try {
    return oracle.verify(signature, message, publicKey, { context });
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}

describe("the Byte contract against the Oracle", () => {
  test("keygen derives the Oracle's key pair from any Seed", () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const ours = mlDsa.keygen(seed);
        const theirs = oracle.keygen(seed);

        expect([upperHex(ours.publicKey), upperHex(ours.secretKey)]).toEqual([
          upperHex(theirs.publicKey),
          upperHex(theirs.secretKey),
        ]);
      }),
    );
  });

  test("sign makes the Oracle's signature from any Secret key, message, Context and Signing randomness", () => {
    fc.assert(
      fc.property(seeds, messages, contexts, rnds, (seed, message, context, rnd) => {
        const { secretKey } = oracle.keygen(seed);
        const args = { secretKey, message, context, rnd };

        expect(upperHex(signWith("ours", args))).toBe(upperHex(signWith("the Oracle", args)));
      }),
    );
  });

  test("verify accepts what either implementation signs, as the Oracle does", () => {
    fc.assert(
      fc.property(signers, seeds, messages, contexts, rnds, (who, seed, message, context, rnd) => {
        const { publicKey, secretKey } = oracle.keygen(seed);
        const signature = signWith(who, { secretKey, message, context, rnd });
        const args = { publicKey, message, context, signature };

        expect([mlDsa.verify(args), oracleVerify(args)]).toEqual([true, true]);
      }),
    );
  });

  interface Edit {
    field: keyof Required<MlDsa87VerifyArgs>;
    kind: "flip" | "truncate" | "extend";
    at: number;
    mask: number;
    tail: Uint8Array;
  }

  // Every edit changes the bytes: a flip XORs a non-zero mask, a truncation drops at least one byte, and an
  // empty value can only grow.
  const edits: fc.Arbitrary<Edit> = fc.record({
    field: fc.constantFrom("publicKey", "message", "context", "signature"),
    kind: fc.constantFrom("flip", "truncate", "extend"),
    at: fc.nat(),
    mask: fc.integer({ min: 1, max: 255 }),
    tail: fc.uint8Array({ minLength: 1, maxLength: 300, size: "max" }),
  });

  function mutate(value: Uint8Array, { kind, at, mask, tail }: Edit): Uint8Array {
    if (kind === "extend" || value.length === 0) {
      return Uint8Array.of(...value, ...tail);
    }
    if (kind === "truncate") {
      return value.slice(0, at % value.length);
    }
    const flipped = Buffer.from(value);
    const index = at % flipped.length;
    flipped.writeUInt8(flipped.readUInt8(index) ^ mask, index);
    return new Uint8Array(flipped);
  }

  test("verify rejects a mutated signature, message, Context or Public key, as the Oracle does", () => {
    fc.assert(
      fc.property(
        signers,
        seeds,
        messages,
        contexts,
        rnds,
        edits,
        (who, seed, message, context, rnd, edit) => {
          const { publicKey, secretKey } = oracle.keygen(seed);
          const signature = signWith(who, { secretKey, message, context, rnd });
          const valid = { publicKey, message, context, signature };
          const mutated = { ...valid, [edit.field]: mutate(valid[edit.field], edit) };

          expect([mlDsa.verify(mutated), oracleVerify(mutated)]).toEqual([false, false]);
        },
      ),
    );
  });

  // The Oracle's throws are asserted too, so the inputs really are the ones it throws on.
  test("verify answers false where the Oracle throws", () => {
    fc.assert(
      fc.property(
        seeds,
        messages,
        fc.uint8Array({ minLength: 256, maxLength: 1024, size: "max" }),
        fc.oneof(
          fc.uint8Array({ maxLength: 2591, size: "max" }),
          fc.uint8Array({ minLength: 2593, maxLength: 4096, size: "max" }),
        ),
        (seed, message, longContext, wrongPublicKey) => {
          const { publicKey, secretKey } = oracle.keygen(seed);
          const signature = mlDsa.sign({ secretKey, message, rnd: new Uint8Array(32) });

          expect(() => oracle.verify(signature, message, publicKey, { context: longContext })).toThrow(
            RangeError,
          );
          expect(() => oracle.verify(signature, message, wrongPublicKey)).toThrow(RangeError);
          expect([
            mlDsa.verify({ publicKey, message, signature }),
            mlDsa.verify({ publicKey, message, context: longContext, signature }),
            mlDsa.verify({ publicKey: wrongPublicKey, message, signature }),
          ]).toEqual([true, false, false]);
        },
      ),
    );
  });
});
