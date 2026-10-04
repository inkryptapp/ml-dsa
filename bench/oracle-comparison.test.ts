import { ml_dsa87 as oracle } from "@noble/post-quantum/ml-dsa.js";
import { expect, test } from "vitest";
import { type MlDsa87KeyPair, loadMlDsa87 } from "../src/index.js";
import { CONTEXT_BYTES, GATED, ITERATIONS, MESSAGE_BYTES, type Means, WARM_UP } from "./method.js";

interface Input {
  seed: Uint8Array;
  message: Uint8Array;
  context: Uint8Array;
  rnd: Uint8Array;
}

interface Implementation {
  keygen(seed: Uint8Array): MlDsa87KeyPair;
  /** Hedged signing, with the input's Signing randomness. */
  sign(secretKey: Uint8Array, input: Input): Uint8Array;
  verify(publicKey: Uint8Array, input: Input, signature: Uint8Array): boolean;
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const inputs: Input[] = Array.from({ length: ITERATIONS }, () => ({
  seed: random(32),
  message: random(MESSAGE_BYTES),
  context: random(CONTEXT_BYTES),
  rnd: random(32),
}));

const mlDsa = await loadMlDsa87();
const ours: Implementation = {
  keygen: (seed) => mlDsa.keygen(seed),
  sign: (secretKey, { message, context, rnd }) => mlDsa.sign({ secretKey, message, context, rnd }),
  verify: (publicKey, { message, context }, signature) =>
    mlDsa.verify({ publicKey, message, context, signature }),
};
const theirs: Implementation = {
  keygen: (seed) => oracle.keygen(seed),
  sign: (secretKey, { message, context, rnd }) =>
    oracle.sign(message, secretKey, { context, extraEntropy: rnd }),
  verify: (publicKey, { message, context }, signature) =>
    oracle.verify(signature, message, publicKey, { context }),
};

/** The mean milliseconds per call over every case, after calls on the first WARM_UP cases. */
function meanMs<Case>(cases: Case[], call: (each: Case) => unknown): number {
  for (const each of cases.slice(0, WARM_UP)) {
    call(each);
  }
  const start = performance.now();
  for (const each of cases) {
    call(each);
  }
  return (performance.now() - start) / cases.length;
}

function measure(implementation: Implementation): Means {
  const signed = inputs.map((input) => {
    const keys = implementation.keygen(input.seed);
    return { input, keys, signature: implementation.sign(keys.secretKey, input) };
  });
  return {
    keygen: meanMs(inputs, ({ seed }) => implementation.keygen(seed)),
    sign: meanMs(signed, ({ input, keys }) => implementation.sign(keys.secretKey, input)),
    // Every signature is valid, so verify does its full work rather than rejecting early.
    verify: meanMs(signed, ({ input, keys, signature }) => {
      if (!implementation.verify(keys.publicKey, input, signature)) {
        throw new Error("a valid signature failed to verify");
      }
    }),
  };
}

/** Such as `HeadlessChrome/153.0.8010.12`, `Firefox/155.0` or `Safari 26.6`, or the whole user agent. */
function browserVersion(userAgent: string): string {
  const safari = /Version\/(\S+) .*Safari\//.exec(userAgent)?.[1];
  return (
    /HeadlessChrome\/\S+|Firefox\/\S+/.exec(userAgent)?.[0] ??
    (safari === undefined ? userAgent : `Safari ${safari}`)
  );
}

test("sign and verify are no slower than the Oracle", ({ task }) => {
  const inBrowser = typeof document !== "undefined";
  // Browsers coarsen performance.now() unless the page is cross-origin isolated.
  if (inBrowser) {
    expect(crossOriginIsolated).toBe(true);
  }

  const packageMeans = measure(ours);
  const oracleMeans = measure(theirs);
  task.meta.oracleComparison = {
    runtime: inBrowser ? browserVersion(navigator.userAgent) : `Node ${process.versions.node}`,
    package: packageMeans,
    oracle: oracleMeans,
  };

  const slower = [...GATED].filter((operation) => packageMeans[operation] > oracleMeans[operation]);
  expect(slower).toEqual([]);
});
