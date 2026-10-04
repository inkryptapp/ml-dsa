#!/usr/bin/env node
// Writes test/vectors/acvp-ml-dsa-87.json: every ML-DSA-87 test group of NIST's ACVP keyGen, and the sigGen and
// sigVer groups for the external interface with pure ML-DSA, taken from usnistgov/ACVP-Server at a pinned commit.
// Each source file must match its recorded SHA-256. Selected groups are copied unchanged, and the output records the
// commit and the hashes, so rerunning the script rewrites the same bytes.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const COMMIT = "975de31eb83d87039ec88934fdc47d8c312b892d";
const SELECTED_ON = "2026-10-03";

const SOURCES = {
  keyGen: {
    file: "gen-val/json-files/ML-DSA-keyGen-FIPS204/internalProjection.json",
    sha256: "e67ee6540d40e11506c3c4e3b1f79fc1cefcd49820db99fc61f87cc8ba463baf",
    select: (group) => group.parameterSet === "ML-DSA-87",
  },
  sigGen: {
    file: "gen-val/json-files/ML-DSA-sigGen-FIPS204/internalProjection.json",
    sha256: "72dcaf5f69853ca267ccd16af9cb40949786aca0fcfbf05d1ebeba132b93af22",
    select: isExternalPure87,
  },
  sigVer: {
    file: "gen-val/json-files/ML-DSA-sigVer-FIPS204/internalProjection.json",
    sha256: "47cdd6314c7f746d02421ffcba89d4dbc7bb875ac49e07a029fdfc26fba55437",
    select: isExternalPure87,
  },
};

// The NIST notice is the "License" section of the README at the same commit.
const README = {
  file: "README.md",
  sha256: "d5a569884ee83bd1c4737042d0a2cc7d68c6950690f75a73ef14f505a9aa3555",
};

function isExternalPure87(group) {
  return (
    group.parameterSet === "ML-DSA-87" &&
    group.signatureInterface === "external" &&
    group.preHash === "pure" &&
    group.externalMu === false
  );
}

async function fetchPinned({ file, sha256 }) {
  const url = `https://raw.githubusercontent.com/usnistgov/ACVP-Server/${COMMIT}/${file}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) {
    throw new Error(`${url}: SHA-256 ${actual}, expected ${sha256}`);
  }
  return bytes.toString("utf8");
}

function licenseSection(readme) {
  const match = /^## License\s*\n([\s\S]*?)\n## /m.exec(readme);
  if (match?.[1] === undefined) {
    throw new Error("README.md has no License section");
  }
  return match[1].trim();
}

const capture = {
  source: `https://github.com/usnistgov/ACVP-Server/tree/${COMMIT}`,
  commit: COMMIT,
  licenseSource: README,
  license: licenseSection(await fetchPinned(README)),
  modification:
    `Selected on ${SELECTED_ON} for @inkrypt/ml-dsa by scripts/fetch-acvp-vectors.mjs: every ML-DSA-87 keyGen group, ` +
    "and the ML-DSA-87 sigGen and sigVer groups for the external interface with pure ML-DSA. " +
    "Each selected group is copied unchanged. Nothing else was changed.",
};

const modes = await Promise.all(
  Object.entries(SOURCES).map(async ([mode, source]) => {
    const { vsId, revision, testGroups } = JSON.parse(await fetchPinned(source));
    const groups = testGroups.filter(source.select);
    if (groups.length === 0) {
      throw new Error(`${source.file}: no group selected`);
    }
    return [mode, { file: source.file, sha256: source.sha256, vsId, revision, groups }];
  }),
);
Object.assign(capture, Object.fromEntries(modes));

const output = fileURLToPath(new URL("../test/vectors/acvp-ml-dsa-87.json", import.meta.url));
await writeFile(output, `${JSON.stringify(capture, null, 2)}\n`);
console.log(
  `wrote test/vectors/acvp-ml-dsa-87.json at ACVP-Server ${COMMIT}: ` +
    Object.keys(SOURCES)
      .map((mode) => `${mode} ${capture[mode].groups.reduce((n, group) => n + group.tests.length, 0)} tests`)
      .join(", "),
);
