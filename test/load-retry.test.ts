import { afterEach, expect, test, vi } from "vitest";
import { loadMlDsa87 } from "../src/index.js";
import { acvp, bytes, upperHex } from "./acvp.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// Every test file runs in its own realm, in Node and in browsers, so the realm's instance starts unloaded here.
test("a failed load is not cached, so the next load retries", async () => {
  vi.spyOn(WebAssembly, "instantiate").mockRejectedValueOnce(new Error("a transient failure"));

  await expect(loadMlDsa87()).rejects.toThrow("a transient failure");
  const mlDsa = await loadMlDsa87();

  const [vector] = acvp.keyGen.groups.flatMap((group) => group.tests);
  if (vector === undefined) {
    throw new Error("the capture has no keyGen test");
  }
  expect(upperHex(mlDsa.keygen(bytes(vector.seed)).publicKey)).toBe(vector.pk);
});
