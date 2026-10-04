import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { OracleComparisonTable } from "./bench/table-reporter.js";

// `pnpm bench`: on demand, never part of `pnpm check`. The runtimes run one after another, so no two compete for
// the CPU.
export default defineConfig({
  // Cross-origin isolation, so browsers give performance.now() its full precision.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    include: ["bench/**/*.test.ts"],
    testTimeout: 600_000,
    reporters: ["default", new OracleComparisonTable()],
    projects: [
      { extends: true, test: { name: "node", sequence: { groupOrder: 0 } } },
      ...(["chromium", "firefox", "webkit"] as const).map((browser, index) => ({
        extends: true,
        test: {
          name: browser,
          sequence: { groupOrder: index + 1 },
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser, name: browser }],
          },
        },
      })),
    ],
  },
});
