import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";

const run = promisify(execFile);
const script = (name: string) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "check-artifact-"));
afterAll(() => rm(directory, { recursive: true, force: true }));

const leb128 = (value: number): number[] =>
  value < 0x80 ? [value] : [(value & 0x7f) | 0x80, ...leb128(value >>> 7)];
const name = (text: string) => [...leb128(text.length), ...new TextEncoder().encode(text)];
const section = (id: number, body: number[]) => [id, ...leb128(body.length), ...body];
const custom = (title: string, body: number[]) => section(0, [...name(title), ...body]);

const producers = (clang: string) =>
  custom("producers", [1, ...name("processed-by"), 1, ...name("clang"), ...name(clang)]);
const features = (...used: string[]) =>
  custom("target_features", [used.length, ...used.flatMap((feature) => [0x2b].concat(name(feature)))]);
/** A type section with `() -> ()` and an import of it as `env.f`. */
const anImport = [...section(1, [1, 0x60, 0, 0]), ...section(2, [1, ...name("env"), ...name("f"), 0, 0])];

const wasm = (...sections: number[][]) => Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat());
const allowed = features("bulk-memory", "bulk-memory-opt");

// The shape of upstream's ct-tests.yml: compilers are the matrix's `nix-shell` entries. clang 23 appears only in a
// step condition, which doesn't put it in the matrix.
const ctTests = `jobs:
  check-ct-varlat:
    strategy:
      matrix:
        system: [ubuntu-latest, ubuntu-24.04-arm]
        nix-shell:
          - valgrind-varlat_clang21
          - valgrind-varlat_clang22
          - valgrind-varlat_gcc15
    steps:
      - name: Build and run test (-Ofast)
        if: \${{ matrix.nix-shell != 'valgrind-varlat_clang23' }}
`;

let count = 0;
async function writeTemp(contents: string | Uint8Array): Promise<string> {
  const path = join(directory, `${count++}`);
  await writeFile(path, contents);
  return path;
}

/** Writes `committed` as the artifact module, runs the check against `rebuilt`, and lists the checks that failed. */
async function failedChecks(committed: Uint8Array, rebuilt: Uint8Array[] = [committed]): Promise<string[]> {
  const artifact = join(directory, `${count++}.ts`);
  await run(process.execPath, [script("generate-artifact.mjs"), await writeTemp(committed), artifact]);
  const args = [
    script("check-artifact.mjs"),
    "--artifact",
    artifact,
    "--ct-tests",
    await writeTemp(ctTests),
    ...(await Promise.all(rebuilt.map((bytes) => writeTemp(bytes)))),
  ];
  const { code, stderr } = await run(process.execPath, args).then(
    (output) => ({ code: 0, stderr: output.stderr }),
    (error: { code: number; stderr: string }) => error,
  );
  const failed = Array.from(stderr.matchAll(/^FAIL (\w+):/gm), ([, check = ""]) => check);
  expect(code).toBe(failed.length === 0 ? 0 : 1);
  return failed;
}

describe("the artifact check", () => {
  test("passes a module with a matrix clang, the allowed features, no imports, and identical rebuilds", async () => {
    const module = wasm(producers("22.1.5"), allowed);

    expect(await failedChecks(module, [module, module])).toEqual([]);
  });

  test("passes the committed artifact against a matrix with clang 22", async () => {
    const source = await readFile(new URL("../src/mldsa87-wasm.ts", import.meta.url), "utf8");
    const base64 = /"([A-Za-z0-9+/=]+)"/.exec(source)?.[1] ?? "";

    expect(await failedChecks(new Uint8Array(Buffer.from(base64, "base64")))).toEqual([]);
  });

  test("passes a module with no target_features section, which is mvp", async () => {
    expect(await failedChecks(wasm(producers("22.1.5")))).toEqual([]);
  });

  test("fails a rebuild that differs from the committed artifact", async () => {
    const module = wasm(producers("22.1.5"), allowed);

    expect(await failedChecks(module, [module, wasm(producers("22.1.6"), allowed)])).toEqual(["rebuild"]);
  });

  test("fails a module with an import", async () => {
    expect(await failedChecks(wasm(anImport, producers("22.1.5"), allowed))).toEqual(["imports"]);
  });

  test("fails a feature outside bulk-memory and bulk-memory-opt", async () => {
    expect(await failedChecks(wasm(producers("22.1.5"), features("bulk-memory", "simd128")))).toEqual([
      "target_features",
    ]);
  });

  test("fails a clang that only a step condition mentions, not the matrix", async () => {
    expect(await failedChecks(wasm(producers("23.1.0"), allowed))).toEqual(["producers"]);
  });

  test("fails a matrix clang older than the newest, which ADR 0001 requires", async () => {
    expect(await failedChecks(wasm(producers("21.1.8"), allowed))).toEqual(["producers"]);
  });

  test("fails a module that names no clang", async () => {
    expect(await failedChecks(wasm(allowed))).toEqual(["producers"]);
  });
});
