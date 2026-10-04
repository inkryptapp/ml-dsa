import { expect, inject, test } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** The browser `scripts/browser-matrix.mjs` installed or found for this project, which the matrix reports. */
    matrixBrowser: { name: "chrome" | "firefox" | "safari"; version: string };
  }
}

/** Where each browser names its major version in its user agent. Chrome and Firefox report no more than the major. */
const userAgentMajor = { chrome: /Chrome\/(\d+)\./, firefox: /Firefox\/(\d+)\./, safari: /Version\/(\d+)\./ };

const { name, version } = inject("matrixBrowser");
const major = version.split(".")[0];

test(`the project labelled ${name} ${version} runs in ${name} ${major}`, () => {
  expect(navigator.userAgent.match(userAgentMajor[name])?.[1]).toBe(major);
});
