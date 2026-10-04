import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** What every browser project runs: the whole suite but the Node-only tests. The version matrix reuses it. */
export const browserSuite = {
  include: ["test/**/*.test.ts"],
  exclude: ["test/**/*.node.test.ts"],
  globalSetup: ["test/compile-package.ts"],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.browser.test.ts"],
          globalSetup: ["test/compile-package.ts"],
        },
      },
      {
        test: {
          name: "browser",
          ...browserSuite,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
          },
        },
      },
    ],
  },
});
