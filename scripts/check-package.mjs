#!/usr/bin/env node
// Packs the package with `pnpm pack`, as publishing would, and checks the tarball against the spec's package shape:
//   node scripts/check-package.mjs [<package directory>]
//
// - files: it ships exactly the entry module, the API module and its imports, the generated artifact module, their
//   declarations, the licences and the README;
// - imports: every import in a shipped module is static, has a string-literal specifier, and names a shipped file;
// - exports: the exports map has a single `.` entry, with types;
// - sideEffects: it is `false`;
// - dependencies: there are none at runtime;
// - license: it is `Apache-2.0 OR MIT`.
//
// Prints one line per check, failures to stderr as `FAIL <check>: ...`, and exits 1 if any check fails.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

const SHIPPED = [
  "LICENSE-APACHE",
  "LICENSE-MIT",
  "README.md",
  "dist/LICENSE-mldsa-native",
  "dist/base64.d.ts",
  "dist/base64.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/mldsa87-wasm.d.ts",
  "dist/mldsa87-wasm.js",
  "dist/mldsa87.d.ts",
  "dist/mldsa87.js",
  "package.json",
];
const EXPORTS = { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } };

const packageDirectory = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));

let failed = false;
/** @param {string} check @param {boolean} ok @param {string} detail */
function report(check, ok, detail) {
  if (ok) {
    console.log(`ok ${check}: ${detail}`);
  } else {
    failed = true;
    console.error(`FAIL ${check}: ${detail}`);
  }
}

/** @param {string} directory @returns {Promise<string[]>} every file under it, relative to it, with `/` separators */
async function filesUnder(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .toSorted();
}

const work = await mkdtemp(join(tmpdir(), "check-package-"));
try {
  // `pnpm pack` runs the prepack script, which builds dist/ from scratch.
  execFileSync("pnpm", ["pack", "--out", join(work, "package.tgz")], {
    cwd: packageDirectory,
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync("tar", ["-xzf", "package.tgz"], { cwd: work });
  const unpacked = join(work, "package");
  const shipped = await filesUnder(unpacked);

  const unexpected = shipped.filter((path) => !SHIPPED.includes(path));
  const missing = SHIPPED.filter((path) => !shipped.includes(path));
  report(
    "files",
    unexpected.length === 0 && missing.length === 0,
    [
      unexpected.length > 0 ? `ships ${unexpected.join(", ")}` : "",
      missing.length > 0 ? `lacks ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || `${shipped.length} files, as expected`,
  );

  await init;
  const modules = await Promise.all(
    shipped
      .filter((file) => file.endsWith(".js"))
      .map(async (path) => ({ path, source: await readFile(join(unpacked, path), "utf8") })),
  );
  const problems = modules.flatMap(({ path, source }) =>
    parse(source, path)[0].flatMap(({ n: specifier, d: kind }) => {
      // `d` is -1 for a static import or re-export, -2 for import.meta, and the position of `import(` otherwise. A
      // dynamic import's specifier is undefined unless it's a string literal. A static import's always is one.
      if (kind === -2) {
        return [];
      }
      if (kind !== -1) {
        return [`${path} imports ${specifier ?? "a computed specifier"} dynamically`];
      }
      if (specifier === undefined) {
        return [];
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        return [`${path} imports ${specifier}, another package`];
      }
      if (!shipped.includes(posix.join(posix.dirname(path), specifier))) {
        return [`${path} imports ${specifier}, which the package doesn't ship`];
      }
      return [];
    }),
  );
  report(
    "imports",
    problems.length === 0,
    problems.join("; ") || "all static, with string literals, of shipped files",
  );

  const manifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));
  const exportsMatch = JSON.stringify(manifest.exports) === JSON.stringify(EXPORTS);
  report("exports", exportsMatch, JSON.stringify(manifest.exports));
  report("sideEffects", manifest.sideEffects === false, String(manifest.sideEffects));
  const runtime = ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"].flatMap(
    (field) => Object.keys(manifest[field] ?? {}).map((name) => `${field}.${name}`),
  );
  report("dependencies", runtime.length === 0, runtime.join(", ") || "none");
  report("license", manifest.license === "Apache-2.0 OR MIT", String(manifest.license));
} finally {
  await rm(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
