#!/usr/bin/env node
// `pnpm test:matrix`: runs the browser suite, Worker tests included, on Chrome N and N-1 and Firefox N and N-1,
// each installed by version, and on this Mac's own Safari through safaridriver. Prints the versions it ran.
//
// N is today's stable major. Installs go to node_modules/.cache/browsers, so a rerun on the same day downloads
// nothing. Safari needs Remote Automation, once: `sudo safaridriver --enable`.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Browser, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";

const root = fileURLToPath(new URL("..", import.meta.url));
const cacheDir = fileURLToPath(new URL("../node_modules/.cache/browsers", import.meta.url));
const platform = detectBrowserPlatform();
if (platform === undefined) {
  throw new Error("@puppeteer/browsers doesn't support this platform");
}

/** @param {string} version */
const major = (version) => Number(version.split(".")[0]);
const FIREFOX_STABLE = "stable_";

/** Chrome for Testing: the stable channel, and the newest build of the major before it. Its build IDs are versions. */
async function chromeBuilds() {
  const stable = await resolveBuildId(Browser.CHROME, platform, "stable");
  const previous = await resolveBuildId(Browser.CHROME, platform, String(major(stable) - 1));
  return [stable, previous].map((version) => ({ buildId: version, version }));
}

/** Firefox: the latest release, and the newest release of the major before it. ESR builds and betas don't count. */
async function firefoxBuilds() {
  const stable = (await resolveBuildId(Browser.FIREFOX, platform, "stable")).slice(FIREFOX_STABLE.length);
  const response = await fetch("https://product-details.mozilla.org/1.0/firefox.json");
  if (!response.ok) {
    throw new Error(`product-details answered ${response.status}`);
  }
  const { releases } = await response.json();
  const previous = Object.entries(releases)
    .filter(
      ([key, { category }]) => !key.endsWith("esr") && (category === "major" || category === "stability"),
    )
    .map(([, { version }]) => version)
    .filter((version) => major(version) === major(stable) - 1)
    .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  if (previous === undefined) {
    throw new Error(`no Firefox ${major(stable) - 1} release found`);
  }
  return [stable, previous].map((version) => ({ buildId: `${FIREFOX_STABLE}${version}`, version }));
}

/**
 * Installs the build unless the cache has it, and describes it as vitest.matrix.config.ts expects.
 * @param {Browser.CHROME | Browser.FIREFOX} browser
 * @param {{ buildId: string, version: string }} build
 */
async function installBrowser(browser, { buildId, version }) {
  const { executablePath } = await install({ browser, buildId, cacheDir, platform });
  return { name: browser, version, executablePath };
}

const [chrome, firefox] = await Promise.all([chromeBuilds(), firefoxBuilds()]);
const browsers = await Promise.all([
  ...chrome.map((build) => installBrowser(Browser.CHROME, build)),
  ...firefox.map((build) => installBrowser(Browser.FIREFOX, build)),
]);
const safariVersion = execFileSync(
  "plutil",
  ["-extract", "CFBundleShortVersionString", "raw", "/Applications/Safari.app/Contents/Info.plist"],
  { encoding: "utf8" },
).trim();
browsers.push({ name: "safari", version: safariVersion });

const versions = browsers.map(({ name, version }) => `  ${name} ${version}`).join("\n");
console.log(`Browser matrix:\n${versions}\n`);
const { status } = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.matrix.config.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env, MATRIX_BROWSERS: JSON.stringify(browsers) } },
);
console.log(`\nBrowser matrix ${status === 0 ? "passed" : "failed"} on:\n${versions}`);
process.exit(status ?? 1);
