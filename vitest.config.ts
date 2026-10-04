import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

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
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.node.test.ts"],
          globalSetup: ["test/compile-package.ts"],
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
