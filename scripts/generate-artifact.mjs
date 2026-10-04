#!/usr/bin/env node
// Writes the committed artifact module (ADR 0004) from a built .wasm, to src/mldsa87-wasm.ts unless told otherwise:
//   node scripts/generate-artifact.mjs <path to mldsa87.wasm> [<output path>]
import { readFile, writeFile } from "node:fs/promises";
import { ARTIFACT_PATH, artifactModule } from "./artifact.mjs";

const [input, output = ARTIFACT_PATH] = process.argv.slice(2);
if (input === undefined) {
  console.error("usage: node scripts/generate-artifact.mjs <path to mldsa87.wasm> [<output path>]");
  process.exit(1);
}

const wasm = await readFile(input);
await writeFile(output, artifactModule(wasm));
console.log(`wrote ${output} from ${wasm.length} bytes of wasm`);
