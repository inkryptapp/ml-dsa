import type { MlDsa87KeyPair, MlDsa87SignArgs, MlDsa87VerifyArgs } from "../src/index.js";
import { acvp, bytes, upperHex } from "./acvp.js";

const keyGen = acvp.keyGen.groups[0]?.tests[0];
const hedged = acvp.sigGen.groups.find((group) => !group.deterministic);
const sigGen = hedged?.deterministic === false ? hedged.tests[0] : undefined;
const sigVer = acvp.sigVer.groups[0]?.tests.find((entry) => entry.testPassed);
if (keyGen === undefined || sigGen === undefined || sigVer === undefined) {
  throw new Error("the capture lacks a keyGen, hedged sigGen or valid sigVer test");
}

/** What a Worker is sent: the package to import, and one ACVP input each for keygen, sign and verify. */
export interface KnownVectorRequest {
  packageUrl: string;
  seed: Uint8Array;
  sign: MlDsa87SignArgs;
  verify: MlDsa87VerifyArgs;
}

/** What a Worker answers: the outputs it computed, or why it couldn't. */
export type KnownVectorReply =
  | (MlDsa87KeyPair & { signature: Uint8Array; verified: boolean })
  | { error: string };

const inputs: Omit<KnownVectorRequest, "packageUrl"> = {
  seed: bytes(keyGen.seed),
  sign: {
    secretKey: bytes(sigGen.sk),
    message: bytes(sigGen.message),
    context: bytes(sigGen.context),
    rnd: bytes(sigGen.rnd),
  },
  verify: {
    publicKey: bytes(sigVer.pk),
    message: bytes(sigVer.message),
    context: bytes(sigVer.context),
    signature: bytes(sigVer.signature),
  },
};

export const knownVectorRequest = (packageUrl: string): KnownVectorRequest => ({ packageUrl, ...inputs });

/** The ACVP answers, in hex as `outputsInHex` gives them. */
export const expectedOutputs = {
  publicKey: keyGen.pk,
  secretKey: keyGen.sk,
  signature: sigGen.signature,
  verified: true,
};

/** A reply's outputs in hex, or the Worker's error thrown. */
export function outputsInHex(reply: KnownVectorReply) {
  if ("error" in reply) {
    throw new Error(reply.error);
  }
  return {
    publicKey: upperHex(reply.publicKey),
    secretKey: upperHex(reply.secretKey),
    signature: upperHex(reply.signature),
    verified: reply.verified,
  };
}
