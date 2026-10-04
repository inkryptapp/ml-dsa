import { playwright } from "@vitest/browser-playwright";
import { webdriverio } from "@vitest/browser-webdriverio";
import { defineConfig } from "vitest/config";
import { z } from "zod";
import type { TestProjectInlineConfiguration } from "vitest/config";
import type { BrowserConfigOptions } from "vitest/node";
import { browserSuite } from "./vitest.config.js";

/**
 * The browsers `scripts/browser-matrix.mjs` installed or found, passed in through MATRIX_BROWSERS. safaridriver
 * finds the system Safari itself, so Safari has no executable path.
 */
const MatrixBrowsers = z
  .array(
    z.discriminatedUnion("name", [
      z.object({ name: z.enum(["chrome", "firefox"]), version: z.string(), executablePath: z.string() }),
      z.object({ name: z.literal("safari"), version: z.string() }),
    ]),
  )
  .nonempty("run the browser matrix with `pnpm test:matrix`");
type MatrixBrowser = z.infer<typeof MatrixBrowsers>[number];

const browsers = MatrixBrowsers.parse(JSON.parse(process.env["MATRIX_BROWSERS"] ?? "[]"));

/**
 * Chrome runs under Playwright like the default browser projects. Playwright drives only its own patched Firefox,
 * so a stock Firefox runs under WebdriverIO and geckodriver, as Safari does under safaridriver.
 */
function browserConfig(browser: MatrixBrowser): BrowserConfigOptions {
  const common = { enabled: true, screenshotFailures: false };
  switch (browser.name) {
    case "chrome":
      return {
        ...common,
        headless: true,
        provider: playwright({ launchOptions: { executablePath: browser.executablePath } }),
        instances: [{ browser: "chromium" }],
      };
    case "firefox":
      return {
        ...common,
        headless: true,
        provider: webdriverio({ capabilities: { "moz:firefoxOptions": { binary: browser.executablePath } } }),
        instances: [{ browser: "firefox" }],
      };
    case "safari":
      // Safari has no headless mode.
      return { ...common, headless: false, provider: webdriverio(), instances: [{ browser: "safari" }] };
  }
}

export default defineConfig({
  test: {
    projects: browsers.map((browser): TestProjectInlineConfiguration => ({
      test: {
        name: `${browser.name} ${browser.version}`,
        ...browserSuite,
        // Proves the project runs the browser it's labelled with, so the versions the matrix reports are the ones that ran.
        include: [...browserSuite.include, "test/browser-version.matrix.ts"],
        provide: { matrixBrowser: { name: browser.name, version: browser.version } },
        browser: browserConfig(browser),
      },
    })),
  },
});
