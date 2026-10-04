import { describe, expect, test } from "vitest";
import { type MlDsa87, loadMlDsa87 } from "../src/index.js";
import { type MlDsa87ForTesting, loadMlDsa87ForTesting } from "../src/testing.js";

const PAINT = 0xa5;

/** Random bytes, so that finding them in memory can only mean a copy was left there. */
const randomBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/**
 * Which of the secrets are still in memory, searched for across the whole memory rather than in the regions the
 * package means to use. The Secret key is searched for in 32-byte pieces after its first 32 bytes, which are the
 * public ρ that the Public key also holds.
 */
function secretsIn(memory: WebAssembly.Memory, secrets: Record<string, Uint8Array>): string[] {
  const bytes = Buffer.from(memory.buffer);
  return Object.entries(secrets).flatMap(([name, secret]) => {
    const pieces =
      secret.length === 32
        ? [secret]
        : Array.from({ length: (secret.length - 32) / 32 }, (_, index) =>
            secret.subarray(32 * (index + 1), 32 * (index + 2)),
          );
    return pieces.some((piece) => bytes.indexOf(piece) !== -1) ? [name] : [];
  });
}

interface Probe {
  mlDsa: MlDsa87;
  leftovers: (secrets: Record<string, Uint8Array>) => string[];
  stackIsZero: () => boolean;
}

/**
 * A fresh instance whose whole stack is painted non-zero before every call into the module, so a stack that reads
 * as zero afterwards was wiped, not merely left clean by the C code. `after` runs once the module has returned,
 * and its result stands in for the module's.
 */
async function probe(after?: (probe: Probe) => unknown): Promise<Probe> {
  const instance: MlDsa87ForTesting = await loadMlDsa87ForTesting((_operation, call) => {
    instance.stackBytes().fill(PAINT);
    const result = call();
    return after === undefined ? result : after(loaded);
  });
  const loaded: Probe = {
    mlDsa: instance.mlDsa,
    leftovers: (secrets) => secretsIn(instance.memory, secrets),
    stackIsZero: () => instance.stackBytes().every((byte) => byte === 0),
  };
  return loaded;
}

const context = new TextEncoder().encode("a context");

describe("after a call returns", () => {
  test("keygen leaves neither the Seed nor the Secret key in memory, and a zero stack", async () => {
    const { mlDsa, leftovers, stackIsZero } = await probe();
    const seed = randomBytes(32);

    const { secretKey } = mlDsa.keygen(seed);

    expect([leftovers({ seed, secretKey }), stackIsZero()]).toEqual([[], true]);
  });

  test("sign leaves neither the Secret key nor the Signing randomness in memory, and a zero stack", async () => {
    const { mlDsa, leftovers, stackIsZero } = await probe();
    const { secretKey } = mlDsa.keygen(randomBytes(32));
    const rnd = randomBytes(32);

    mlDsa.sign({ secretKey, message: randomBytes(100), context, rnd });

    expect([leftovers({ secretKey, rnd }), stackIsZero()]).toEqual([[], true]);
  });

  test("sign wipes the grown memory after a message that didn't fit", async () => {
    const { mlDsa, leftovers, stackIsZero } = await probe();
    const { secretKey } = mlDsa.keygen(randomBytes(32));
    const rnd = randomBytes(32);

    mlDsa.sign({ secretKey, message: new Uint8Array(1024 * 1024), context, rnd });

    expect([leftovers({ secretKey, rnd }), stackIsZero()]).toEqual([[], true]);
  });
});

// Upstream reports no failure on any input we can construct, so the module's failures are injected after it has
// run and has left its secrets in memory.
describe("after a call throws", () => {
  test.each([
    [
      "traps",
      (): never => {
        throw new WebAssembly.RuntimeError("unreachable");
      },
      WebAssembly.RuntimeError,
    ],
    ["returns an error code", (): number => -1, expect.objectContaining({ cause: { code: -1 } })],
  ])("keygen and sign wipe when the module %s", async (_name, failure, thrown) => {
    const seed = randomBytes(32);
    const { secretKey } = (await loadMlDsa87()).keygen(seed);
    const rnd = randomBytes(32);
    const secrets = { seed, secretKey, rnd };
    const atFailure: string[][] = [];
    const { mlDsa, leftovers, stackIsZero } = await probe((loaded) => {
      atFailure.push(loaded.leftovers(secrets));
      return failure();
    });

    expect(() => mlDsa.keygen(seed)).toThrow(thrown);
    const afterKeygen = [leftovers(secrets), stackIsZero()];
    expect(() => mlDsa.sign({ secretKey, message: randomBytes(100), context, rnd })).toThrow(thrown);
    const afterSign = [leftovers(secrets), stackIsZero()];

    expect({ atFailure, afterKeygen, afterSign }).toEqual({
      atFailure: [
        ["seed", "secretKey"],
        ["secretKey", "rnd"],
      ],
      afterKeygen: [[], true],
      afterSign: [[], true],
    });
  });
});
