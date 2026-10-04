import { expect, inject, test } from "vitest";
import { type KnownVectorReply, expectedOutputs, knownVectorRequest, outputsInHex } from "./known-vector.js";

test("a module Worker loads the compiled package and runs keygen, sign and verify on a known vector", async () => {
  const worker = new Worker(new URL("./workers/browser.mjs", import.meta.url), { type: "module" });
  try {
    const reply = await new Promise<KnownVectorReply>((resolve, reject) => {
      worker.addEventListener("message", ({ data }) => resolve(data));
      worker.addEventListener("error", (event) =>
        reject(new Error(`the Worker failed: ${event.message || "it did not load"}`)),
      );
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker takes no target origin
      worker.postMessage(knownVectorRequest(`${location.origin}/@fs${inject("compiledPackageEntry")}`));
    });

    expect(outputsInHex(reply)).toEqual(expectedOutputs);
  } finally {
    worker.terminate();
  }
});
