import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { runTool, toolTimeout } from "./dev-tools.js";

/**
 * Compiles one emitted declaration file and what it imports, with only
 * `lib: ["es2024"]` and no `@types` packages, as a consumer without the DOM
 * or Node types would.
 */
function compileAlone(folder: string, file: string): ReturnType<typeof runTool> {
	writeFileSync(
		join(folder, "tsconfig.json"),
		JSON.stringify({
			compilerOptions: {
				lib: ["es2024"],
				types: [],
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				module: "nodenext",
				moduleResolution: "nodenext",
			},
			files: [file],
		}),
	);
	return runTool("tsc", ["-p", folder]);
}

describe("the package's declarations", { timeout: toolTimeout }, () => {
	let folder = "";

	beforeAll(() => {
		folder = mkdtempSync(join(tmpdir(), "ml-dsa-declarations-"));
		const emit = runTool("tsc", [
			"-p",
			"packages/ml-dsa",
			"--noEmit",
			"false",
			"--emitDeclarationOnly",
			"--outDir",
			folder,
		]);
		expect(emit.stdout).toBe("");
		expect(emit.status).toBe(0);
	});

	afterAll(() => {
		rmSync(folder, { recursive: true, force: true });
	});

	test("compile alone from the default entry, with no WebAssembly types", () => {
		expect(readFileSync(join(folder, "src/index.d.ts"), "utf8")).toContain("mlDsa44");
		const result = compileAlone(folder, "src/index.d.ts");
		expect(result.stdout).toBe("");
		expect(result.status).toBe(0);
	});

	// The internal declarations name `WebAssembly`, so this proves that the
	// compile above would catch a public type that reached them.
	test("of the core don't compile alone", () => {
		const result = compileAlone(folder, "src/core.d.ts");
		expect(result.status).not.toBe(0);
		expect(result.stdout).toContain("Cannot find namespace 'WebAssembly'");
	});
});
