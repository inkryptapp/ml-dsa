#!/usr/bin/env node
// Checks the committed artifact module against the rules in ADRs 0001, 0004 and 0005:
//   node scripts/check-artifact.mjs --ct-tests <ct-tests.yml at the Pinned commit> [--artifact <module>] <rebuilt.wasm>...
//
// - rebuild: each rebuilt .wasm regenerates the committed artifact module byte for byte;
// - imports: the module imports nothing;
// - target_features: it uses no wasm feature but bulk-memory and bulk-memory-opt, and a missing section is mvp;
// - producers: the clang that built it is the newest major in the matrix of upstream's constant-time tests.
//
// Prints one line per check, failures to stderr as `FAIL <check>: ...`, and exits 1 if any check fails.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { ARTIFACT_PATH, artifactModule, wasmOfArtifact } from "./artifact.mjs";

const ALLOWED_FEATURES = ["bulk-memory", "bulk-memory-opt"];

const { values, positionals: rebuilt } = parseArgs({
  options: {
    artifact: { type: "string", default: ARTIFACT_PATH },
    "ct-tests": { type: "string" },
  },
  allowPositionals: true,
});
const ctTestsPath = values["ct-tests"];
if (ctTestsPath === undefined || rebuilt.length === 0) {
  console.error(
    "usage: node scripts/check-artifact.mjs --ct-tests <ct-tests.yml> [--artifact <module>] <rebuilt.wasm>...",
  );
  process.exit(2);
}

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

const committed = await readFile(values.artifact, "utf8");
const rebuiltModules = await Promise.all(rebuilt.map(async (path) => artifactModule(await readFile(path))));
for (const [index, path] of rebuilt.entries()) {
  const same = rebuiltModules[index] === committed;
  report(
    "rebuild",
    same,
    `${path} ${same ? "regenerates" : "does not regenerate"} ${values.artifact} byte for byte`,
  );
}

const compiled = new WebAssembly.Module(wasmOfArtifact(committed));

const imports = WebAssembly.Module.imports(compiled).map(({ module, name }) => `${module}.${name}`);
report("imports", imports.length === 0, imports.length === 0 ? "none" : imports.join(", "));

const [featuresSection] = WebAssembly.Module.customSections(compiled, "target_features");
const features =
  featuresSection === undefined
    ? []
    : vector(
        sectionReader(featuresSection),
        (entry) => `${String.fromCharCode(entry.byte())}${entry.name()}`,
      );
const unexpected = features.filter((feature) => !ALLOWED_FEATURES.includes(feature.slice(1)));
report(
  "target_features",
  unexpected.length === 0,
  featuresSection === undefined
    ? "no section, so mvp"
    : `${features.join(" ")}${unexpected.length === 0 ? "" : `; only ${ALLOWED_FEATURES.join(" and ")} are allowed`}`,
);

const matrix = ctMatrixClangMajors(parse(await readFile(ctTestsPath, "utf8")));
const clangs = processedBy(compiled)
  .filter(({ name }) => name === "clang")
  .map(({ version }) => version);
const newest = String(Math.max(...matrix.map(Number)));
const other = clangs.filter((version) => /^\d+/.exec(version)?.[0] !== newest);
report(
  "producers",
  clangs.length > 0 && other.length === 0,
  `${clangs.length === 0 ? "no clang in processed-by" : `clang ${clangs.join(", ")}`}; the CT matrix has clang ${matrix.join(", ")}, and builds use the newest (ADR 0001)`,
);

process.exit(failed ? 1 : 0);

/** The clang majors in the `nix-shell` matrix of each job, such as `valgrind-varlat_clang22`. */
function ctMatrixClangMajors(workflow) {
  return Object.values(workflow?.jobs ?? {}).flatMap((job) =>
    (job?.strategy?.matrix?.["nix-shell"] ?? []).flatMap(
      (shell) => /^valgrind-varlat_clang(\d+)$/.exec(String(shell))?.[1] ?? [],
    ),
  );
}

/** The `processed-by` entries of the producers section. */
function processedBy(wasmModule) {
  const [section] = WebAssembly.Module.customSections(wasmModule, "producers");
  if (section === undefined) {
    return [];
  }
  return vector(sectionReader(section), (field) => ({
    field: field.name(),
    entries: vector(field, (value) => ({ name: value.name(), version: value.name() })),
  })).flatMap(({ field, entries }) => (field === "processed-by" ? entries : []));
}

/** A length-prefixed vector, as the wasm binary format writes it. */
function vector(source, item) {
  return Array.from({ length: source.leb128() }, () => item(source));
}

/** Reads bytes, LEB128 integers and names from a custom section, in order. */
function sectionReader(buffer) {
  const bytes = new Uint8Array(buffer);
  let at = 0;
  const byte = () => {
    if (at >= bytes.length) {
      throw new Error("custom section ends early");
    }
    return bytes[at++];
  };
  const leb128 = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const next = byte();
      value += (next & 0x7f) * 2 ** shift;
      if (next < 0x80) {
        return value;
      }
    }
  };
  const name = () => {
    const length = leb128();
    if (at + length > bytes.length) {
      throw new Error("custom section ends early");
    }
    at += length;
    return new TextDecoder().decode(bytes.subarray(at - length, at));
  };
  return { byte, leb128, name };
}
