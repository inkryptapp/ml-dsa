import { afterEach, expect, test, vi } from "vitest";
import { acvp, bytes, upperHex } from "./acvp.js";

// Each test imports a fresh copy of the package, so the realm's cached instance starts empty.
async function freshPackage() {
  vi.resetModules();
  return import("../src/index.js");
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("repeated loads return the same instance, including loads made while the first is pending", async () => {
  const { loadMlDsa87 } = await freshPackage();

  const [first, concurrent] = await Promise.all([loadMlDsa87(), loadMlDsa87()]);
  const later = await loadMlDsa87();

  expect([concurrent === first, later === first]).toEqual([true, true]);
});

test("a failed load is not cached, so the next load retries", async () => {
  const { loadMlDsa87 } = await freshPackage();
  vi.spyOn(WebAssembly, "instantiate").mockRejectedValueOnce(new Error("a transient failure"));

  await expect(loadMlDsa87()).rejects.toThrow("a transient failure");
  const mlDsa = await loadMlDsa87();

  const [vector] = acvp.keyGen.groups.flatMap((group) => group.tests);
  if (vector === undefined) {
    throw new Error("the capture has no keyGen test");
  }
  expect(upperHex(mlDsa.keygen(bytes(vector.seed)).publicKey)).toBe(vector.pk);
});
