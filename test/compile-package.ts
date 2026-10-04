import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The path of the package's entry point as `tsc` compiles it, which the Worker tests import. */
    compiledPackageEntry: string;
  }
}

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * Compiles the package into a temporary directory beside a copy of its package.json, so the Worker tests load what
 * consumers get rather than the TypeScript sources. The directory sits inside the repository, where the browser
 * tests' server may read it.
 */
export default async function compilePackage(project: TestProject): Promise<() => Promise<void>> {
  const cache = join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "compiled-package-"));
  const removeDirectory = () => rm(directory, { recursive: true, force: true });
  try {
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.build.json",
        "--outDir",
        join(directory, "dist"),
      ],
      { cwd: root, stdio: "inherit" },
    );
    await copyFile(join(root, "package.json"), join(directory, "package.json"));
  } catch (error) {
    await removeDirectory();
    throw error;
  }
  project.provide("compiledPackageEntry", join(directory, "dist/index.js"));
  return removeDirectory;
}
