import { ml_dsa87 as oracle } from "@noble/post-quantum/ml-dsa.js";
import { expect, test } from "vitest";
import { loadMlDsa87 } from "../src/index.js";
import { upperHex } from "./acvp.js";

const mlDsa = await loadMlDsa87();

const { publicKey, secretKey } = mlDsa.keygen(new Uint8Array(32).fill(3));
const context = new TextEncoder().encode("a context");
const rnd = new Uint8Array(32).fill(4);

function oracleSignature(message: Uint8Array): string {
  return upperHex(oracle.sign(message, secretKey, { context, extraEntropy: rnd }));
}

test("a 1 MiB message signs and verifies, and small calls still work after the memory has grown", () => {
  const small = new TextEncoder().encode("a small message");
  const large = new Uint8Array(1024 * 1024).map((_, index) => index % 251);

  const largeSignature = mlDsa.sign({ secretKey, message: large, context, rnd });
  const smallSignature = mlDsa.sign({ secretKey, message: small, context, rnd });

  expect([upperHex(largeSignature), upperHex(smallSignature)]).toEqual([
    oracleSignature(large),
    oracleSignature(small),
  ]);
  expect([
    mlDsa.verify({ publicKey, message: large, context, signature: largeSignature }),
    mlDsa.verify({ publicKey, message: small, context, signature: smallSignature }),
    mlDsa.verify({ publicKey, message: small, context, signature: largeSignature }),
  ]).toEqual([true, true, false]);
});

// An array that viewed the module's memory would change under later calls, and would empty when growing the
// memory detached its buffer.
test("returned keys and signatures are unchanged by later calls, including ones that grow the memory", () => {
  const message = new TextEncoder().encode("a message");
  const keyPair = mlDsa.keygen(new Uint8Array(32).fill(5));
  const signature = mlDsa.sign({ secretKey, message, context, rnd });
  const before = [keyPair.publicKey, keyPair.secretKey, signature].map(upperHex);

  mlDsa.keygen(new Uint8Array(32).fill(6));
  mlDsa.sign({ secretKey: keyPair.secretKey, message: new Uint8Array(3 * 1024 * 1024), context, rnd });

  expect([keyPair.publicKey, keyPair.secretKey, signature].map(upperHex)).toEqual(before);
  expect(before.map((hex) => hex.length / 2)).toEqual([2592, 4896, 4627]);
});
