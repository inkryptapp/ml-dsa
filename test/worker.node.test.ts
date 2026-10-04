import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, inject, test } from "vitest";
import { type KnownVectorReply, expectedOutputs, knownVectorRequest, outputsInHex } from "./known-vector.js";

test("a worker_threads worker loads the compiled package and runs keygen, sign and verify on a known vector", async () => {
  const worker = new Worker(new URL("./workers/node.mjs", import.meta.url), {
    workerData: knownVectorRequest(pathToFileURL(inject("compiledPackageEntry")).href),
  });
  try {
    const [reply] = (await once(worker, "message")) as [KnownVectorReply];

    expect(outputsInHex(reply)).toEqual(expectedOutputs);
  } finally {
    await worker.terminate();
  }
});
