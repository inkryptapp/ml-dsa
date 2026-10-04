import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-package.mjs", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "check-package-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const manifest = {
  name: "fixture",
  version: "0.0.0",
  type: "module",
  license: "Apache-2.0 OR MIT",
  sideEffects: false,
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  files: ["dist", "LICENSE-APACHE", "LICENSE-MIT"],
};

/** A package shaped like this one: the entry module, the API module and its two imports, declarations and licences. */
const wellFormed: Record<string, string> = {
  "README.md": "# fixture\n",
  "LICENSE-APACHE": "Apache\n",
  "LICENSE-MIT": "MIT\n",
  "dist/LICENSE-mldsa-native": "mldsa-native\n",
  "dist/index.js": 'export { loadMlDsa87 } from "./mldsa87.js";\n',
  "dist/index.d.ts": "export {};\n",
  "dist/mldsa87.js": [
    'import { decodeBase64 } from "./base64.js";',
    'import { MLDSA87_WASM_BASE64 } from "./mldsa87-wasm.js";',
    "export const loadMlDsa87 = () => decodeBase64(MLDSA87_WASM_BASE64);",
    "",
  ].join("\n"),
  "dist/mldsa87.d.ts": "export {};\n",
  "dist/base64.js": "export const decodeBase64 = (text) => text;\n",
  "dist/base64.d.ts": "export {};\n",
  "dist/mldsa87-wasm.js": 'export const MLDSA87_WASM_BASE64 = "AGFzbQEAAAA=";\n',
  "dist/mldsa87-wasm.d.ts": "export {};\n",
};

let count = 0;
/** Writes a package from `files`, `undefined` leaving a file out, and returns its directory. */
async function writePackage(
  files: Record<string, string | undefined>,
  packageJson: Record<string, unknown> = manifest,
): Promise<string> {
  const packageDirectory = join(directory, `${count++}`);
  const entries = Object.entries({ "package.json": JSON.stringify(packageJson), ...files });
  await Promise.all(
    entries.map(async ([path, contents]) => {
      if (contents === undefined) {
        return;
      }
      await mkdir(dirname(join(packageDirectory, path)), { recursive: true });
      await writeFile(join(packageDirectory, path), contents);
    }),
  );
  return packageDirectory;
}

/** Packs the package in `packageDirectory`, runs the check on it, and lists the checks that failed. */
async function failedChecks(packageDirectory: string): Promise<string[]> {
  const { code, stderr } = await run(process.execPath, [script, packageDirectory]).then(
    (output) => ({ code: 0, stderr: output.stderr }),
    (error: { code: number; stderr: string }) => error,
  );
  const failed = Array.from(stderr.matchAll(/^FAIL (\w+):/gm), ([, check = ""]) => check);
  expect(code).toBe(failed.length === 0 ? 0 : 1);
  return failed;
}

const withModule = (path: string, source: string) => writePackage({ ...wellFormed, [path]: source });

describe("the package check", () => {
  test("passes this package as `pnpm pack` builds it", { timeout: 60_000 }, async () => {
    expect(await failedChecks(root)).toEqual([]);
  });

  test("passes a package that ships its modules, declarations, licences and README", async () => {
    expect(await failedChecks(await writePackage(wellFormed))).toEqual([]);
  });

  test("fails a package that ships the test-only entry point", async () => {
    const testing = 'export { loadMlDsa87 } from "./mldsa87.js";\n';

    expect(await failedChecks(await withModule("dist/testing.js", testing))).toEqual(["files"]);
  });

  test("fails a package without upstream's licence next to the artifact", async () => {
    expect(
      await failedChecks(await writePackage({ ...wellFormed, "dist/LICENSE-mldsa-native": undefined })),
    ).toEqual(["files"]);
  });

  test("fails a dynamic import", async () => {
    const source = 'export const loadMlDsa87 = () => import("./base64.js");\n';

    expect(await failedChecks(await withModule("dist/mldsa87.js", source))).toEqual(["imports"]);
  });

  test("fails an import whose specifier isn't a string literal", async () => {
    const source = 'const name = "./base64.js";\nexport const loadMlDsa87 = () => import(name);\n';

    expect(await failedChecks(await withModule("dist/mldsa87.js", source))).toEqual(["imports"]);
  });

  test("fails an import of another package", async () => {
    const source = 'export { ml_dsa87 as loadMlDsa87 } from "@noble/post-quantum/ml-dsa.js";\n';

    expect(await failedChecks(await withModule("dist/index.js", source))).toEqual(["imports"]);
  });

  test("fails an import of a file the package doesn't ship", async () => {
    const source = 'export { loadMlDsa87 } from "./mldsa87.js";\nexport * from "./testing.js";\n';

    expect(await failedChecks(await withModule("dist/index.js", source))).toEqual(["imports"]);
  });

  test("fails an exports map with an entry besides `.`", async () => {
    const exports = { ...manifest.exports, "./testing": "./dist/testing.js" };

    expect(await failedChecks(await writePackage(wellFormed, { ...manifest, exports }))).toEqual(["exports"]);
  });

  test("fails a package that may have side effects", async () => {
    const { sideEffects: _, ...rest } = manifest;

    expect(await failedChecks(await writePackage(wellFormed, rest))).toEqual(["sideEffects"]);
  });

  test("fails a runtime dependency", async () => {
    const packageJson = { ...manifest, dependencies: { "@noble/hashes": "2.0.0" } };

    expect(await failedChecks(await writePackage(wellFormed, packageJson))).toEqual(["dependencies"]);
  });

  test("fails a licence other than Apache-2.0 OR MIT", async () => {
    expect(await failedChecks(await writePackage(wellFormed, { ...manifest, license: "MIT" }))).toEqual([
      "license",
    ]);
  });
});
