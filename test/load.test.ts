import { expect, test } from "vitest";
import { loadMlDsa87 } from "../src/index.js";

// Every test file runs in its own realm, in Node and in browsers, so the realm's instance starts unloaded here.
test("repeated loads return the same instance, including loads made while the first is pending", async () => {
  const [first, concurrent] = await Promise.all([loadMlDsa87(), loadMlDsa87()]);
  const later = await loadMlDsa87();

  expect([concurrent === first, later === first]).toEqual([true, true]);
});
