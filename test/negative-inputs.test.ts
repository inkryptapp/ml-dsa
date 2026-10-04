import { describe, expect, test } from "vitest";
import { type MlDsa87SignArgs, type MlDsa87VerifyArgs, loadMlDsa87 } from "../src/index.js";

const mlDsa = await loadMlDsa87();

// Callers may not be type-checked, so the wrong types arrive as they would from plain JavaScript.
const keygen = (seed: unknown) => mlDsa.keygen(seed as Uint8Array);
const sign = (args: unknown) => mlDsa.sign(args as MlDsa87SignArgs);
const verify = (args: unknown) => mlDsa.verify(args as MlDsa87VerifyArgs);

const seed = new Uint8Array(32).fill(1);
const { publicKey, secretKey } = mlDsa.keygen(seed);
const message = new TextEncoder().encode("a message");
const context = new TextEncoder().encode("a context");
const rnd = new Uint8Array(32).fill(2);
const signature = mlDsa.sign({ secretKey, message, context, rnd });

const signArgs = { secretKey, message, context, rnd };
const verifyArgs = { publicKey, message, context, signature };

type TypeCase = [field: string, name: string, value: unknown];

/** The wrong types the matrix tries for each argument. */
function wrongTypes(args: Record<string, Uint8Array>): TypeCase[] {
  return Object.entries(args).flatMap(([field, value]) => {
    const cases: TypeCase[] = [
      [field, "undefined", undefined],
      [field, "null", null],
      [field, "a string", Buffer.from(value).toString("latin1")],
      [field, "an ArrayBuffer", value.slice().buffer],
      [field, "a plain array", Array.from(value)],
      [field, "an Int8Array", new Int8Array(value)],
    ];
    // An undefined Context is the omitted one, which is valid.
    return field === "context" ? cases.slice(1) : cases;
  });
}

type LengthCase = [field: string, length: number, value: Uint8Array];

/** One byte short and one byte long for each fixed-length argument, and a 256-byte Context when `args` has a Context. */
function wrongLengths<Field extends string>(
  args: Record<Field, Uint8Array>,
  fixed: NoInfer<Field>[],
): LengthCase[] {
  const cases = fixed.flatMap((field): LengthCase[] => {
    const value = args[field];
    return [
      [field, value.length - 1, value.slice(0, -1)],
      [field, value.length + 1, Uint8Array.of(...value, 0)],
    ];
  });
  return "context" in args ? [...cases, ["context", 256, new Uint8Array(256)]] : cases;
}

test("the valid arguments the matrix starts from are accepted", () => {
  expect([publicKey.length, secretKey.length, signature.length, verify(verifyArgs)]).toEqual([
    2592,
    4896,
    4627,
    true,
  ]);
});

describe("keygen throws for a Seed it can't use", () => {
  test.each(wrongTypes({ seed }))("TypeError for a %s of %s", (_field, _name, value) => {
    expect(() => keygen(value)).toThrow(TypeError);
  });

  test.each(wrongLengths({ seed }, ["seed"]))("RangeError for a %s of %i bytes", (_field, _length, value) => {
    expect(() => keygen(value)).toThrow(RangeError);
  });

  // An empty array that reports 32 bytes would otherwise run keygen on whatever Seed is already in memory.
  class ClaimsThirtyTwoBytes extends Uint8Array {
    override get length(): number {
      return 32;
    }
  }
  const lyingSeeds = [
    ["an own length property", () => Object.defineProperty(new Uint8Array(0), "length", { value: 32 })],
    ["a subclass length getter", () => new ClaimsThirtyTwoBytes(0)],
  ] as const;

  test.each(lyingSeeds)(
    "RangeError for an empty Seed that claims 32 bytes through %s",
    async (_name, lyingSeed) => {
      const fresh = await loadMlDsa87();
      expect(() => fresh.keygen(lyingSeed())).toThrow(RangeError);

      fresh.keygen(new Uint8Array(32).fill(7));
      expect(() => fresh.keygen(lyingSeed())).toThrow(RangeError);
    },
  );
});

describe("sign throws for arguments it can't use", () => {
  test.each([
    ["a missing argument object", undefined],
    ["null", null],
    ["positional arguments", secretKey],
  ])("TypeError for %s", (_name, args) => {
    expect(() => sign(args)).toThrow(TypeError);
  });

  test.each(wrongTypes(signArgs))("TypeError for a %s of %s", (field, _name, value) => {
    expect(() => sign({ ...signArgs, [field]: value })).toThrow(TypeError);
  });

  test.each(wrongLengths(signArgs, ["secretKey", "rnd"]))(
    "RangeError for a %s of %i bytes",
    (field, _length, value) => {
      expect(() => sign({ ...signArgs, [field]: value })).toThrow(RangeError);
    },
  );
});

// Each case first verifies the valid arguments, which leaves them in memory. An argument verify didn't reject
// up front could then be checked against what an earlier call left behind, such as the rest of a signature.
describe("verify answers false, without throwing, for arguments it can't use", () => {
  test.each([
    ["a missing argument object", undefined],
    ["null", null],
    ["positional arguments", signature],
    [
      "an object whose getter throws",
      {
        get publicKey(): never {
          throw new Error("hostile");
        },
      },
    ],
  ])("%s", (_name, args) => {
    expect([verify(verifyArgs), verify(args)]).toEqual([true, false]);
  });

  test.each(wrongTypes(verifyArgs))("a %s of %s", (field, _name, value) => {
    expect([verify(verifyArgs), verify({ ...verifyArgs, [field]: value })]).toEqual([true, false]);
  });

  test.each([
    ...wrongLengths(verifyArgs, ["publicKey", "signature"]),
    ["signature", 0, new Uint8Array(0)],
    ["signature", 2 * 4627, Uint8Array.of(...signature, ...signature)],
  ])("a %s of %i bytes", (field, _length, value) => {
    expect([verify(verifyArgs), verify({ ...verifyArgs, [field]: value })]).toEqual([true, false]);
  });
});
