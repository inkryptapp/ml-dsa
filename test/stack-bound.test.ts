import * as fc from "fast-check";
import { expect, test } from "vitest";
import { type MlDsa87ForTesting, type Operation, loadMlDsa87ForTesting } from "../src/testing.js";

const STACK_BYTES = 256 * 1024;
const PAINT = 0xa5;

// The stack grows down from its top. Painting it before each call into the module shows, afterwards, the lowest
// byte the call wrote, and so its peak use. A call that wrote the paint value itself at its deepest byte would be
// measured a few bytes short.
const peaks: Record<Operation, number> = { keygen: 0, sign: 0, verify: 0 };
const { mlDsa, stackBytes }: MlDsa87ForTesting = await loadMlDsa87ForTesting((operation, call) => {
  stackBytes().fill(PAINT);
  const result = call();
  const deepest = stackBytes().findIndex((byte) => byte !== PAINT);
  peaks[operation] = Math.max(peaks[operation], deepest === -1 ? 0 : STACK_BYTES - deepest);
  return result;
});

test("the stack region is the 256 KiB the build asks for", () => {
  expect(stackBytes().length).toBe(STACK_BYTES);
});

test("every operation peaks within half the stack on random inputs", () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.uint8Array({ maxLength: 4096, size: "max" }),
      fc.uint8Array({ maxLength: 255, size: "max" }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (seed, message, context, rnd) => {
        const { publicKey, secretKey } = mlDsa.keygen(seed);
        const signature = mlDsa.sign({ secretKey, message, context, rnd });
        expect(mlDsa.verify({ publicKey, message, context, signature })).toBe(true);
      },
    ),
    { numRuns: 50 },
  );

  // A peak of 0 would mean the paint never saw the call. Measured in Node 24: keygen 79,264 bytes, sign 112,448 and
  // verify 73,408.
  expect(Object.entries(peaks).filter(([, peak]) => peak === 0 || peak > STACK_BYTES / 2)).toEqual([]);
});
