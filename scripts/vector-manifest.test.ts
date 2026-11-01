import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, test } from "vite-plus/test";

import { root as repoRoot } from "./check-step.ts";
import { provenanceFailures, readVerifiedVectors, vectorFailures } from "./vector-manifest.ts";

const commit = "975de31eb83d87039ec88934fdc47d8c312b892d";
const repository = "usnistgov/ACVP-Server";
const fixtures: string[] = [];

afterAll(() => {
	for (const fixture of fixtures) {
		rmSync(fixture, { recursive: true, force: true });
	}
});

interface FixtureFile {
	readonly file: string;
	readonly bytes: string;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function entry(file: string, bytes: string): Record<string, string> {
	const path = `gen-val/json-files/${file}`;
	return {
		file,
		repository,
		commit,
		path,
		url: `https://raw.githubusercontent.com/${repository}/${commit}/${path}`,
		sha256: sha256(bytes),
	};
}

const prompt: FixtureFile = { file: "acvp/keyGen/prompt.json", bytes: '{"testGroups":[]}\n' };
const results: FixtureFile = { file: "acvp/keyGen/expectedResults.json", bytes: "{}\n" };

/**
 * A repo root with a `vectors` folder that holds `files` and a manifest of
 * `entries`, which default to an entry for each file.
 */
function fixture(
	files: readonly FixtureFile[],
	entries: readonly unknown[] = files.map(({ file, bytes }) => entry(file, bytes)),
): string {
	const root = mkdtempSync(join(tmpdir(), "vector-manifest-"));
	fixtures.push(root);
	for (const { file, bytes } of files) {
		const path = join(root, "vectors", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
	}
	writeFileSync(join(root, "vectors/manifest.json"), JSON.stringify({ files: entries }));
	return root;
}

describe("vectorFailures", () => {
	test("passes when every file matches its manifest entry", () => {
		expect(vectorFailures(fixture([prompt, results]))).toStrictEqual([]);
	});

	test("names a file whose bytes differ from its entry's SHA-256", () => {
		const changed = { ...results, bytes: "{ }\n" };
		const root = fixture(
			[prompt, changed],
			[entry(prompt.file, prompt.bytes), entry(results.file, results.bytes)],
		);
		expect(vectorFailures(root)).toStrictEqual([
			`vectors/${results.file} has SHA-256 ${sha256(changed.bytes)}, but vectors/manifest.json gives ${sha256(results.bytes)}. Restore the file from https://raw.githubusercontent.com/${repository}/${commit}/gen-val/json-files/${results.file}, or update the manifest and every pinned count with it.`,
		]);
	});

	test("names a file that the manifest lists but the folder lacks", () => {
		const root = fixture(
			[prompt],
			[entry(prompt.file, prompt.bytes), entry(results.file, results.bytes)],
		);
		expect(vectorFailures(root)).toStrictEqual([
			`vectors/${results.file} is missing, but vectors/manifest.json lists it.`,
		]);
	});

	test("names each file in the folder, nested or not, that the manifest doesn't list", () => {
		const stray = { file: "stray.json", bytes: "{}\n" };
		const nested = { file: "wycheproof/extra/mldsa_44_verify_test.json", bytes: "{}\n" };
		const root = fixture(
			[prompt, results, stray, nested],
			[entry(prompt.file, prompt.bytes), entry(results.file, results.bytes)],
		);
		expect(vectorFailures(root)).toStrictEqual([
			"vectors/stray.json isn't in vectors/manifest.json. Add it to the manifest, or delete it.",
			`vectors/${nested.file} isn't in vectors/manifest.json. Add it to the manifest, or delete it.`,
		]);
	});

	test("names a file that the manifest lists twice", () => {
		const twice = entry(prompt.file, prompt.bytes);
		const root = fixture([prompt], [twice, twice]);
		expect(vectorFailures(root)).toStrictEqual([
			`vectors/manifest.json lists ${prompt.file} more than once.`,
		]);
	});

	test("names an entry whose URL isn't the raw URL of its repository, commit, and path", () => {
		const moved = {
			...entry(prompt.file, prompt.bytes),
			url: `https://raw.githubusercontent.com/${repository}/v1.1.0.43/gen-val/json-files/${prompt.file}`,
		};
		const root = fixture([prompt], [moved]);
		expect(vectorFailures(root)).toStrictEqual([
			`vectors/manifest.json gives ${moved.url} as the URL of ${prompt.file}, but its repository, commit, and path give https://raw.githubusercontent.com/${repository}/${commit}/gen-val/json-files/${prompt.file}.`,
		]);
	});

	test("names each field that breaks the manifest's schema", () => {
		const root = fixture(
			[prompt],
			[
				{ ...entry(prompt.file, prompt.bytes), sha256: "abc" },
				{ ...entry("../outside.json", "{}"), commit: "v1.1.0.43" },
			],
		);
		const failures = vectorFailures(root);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/^vectors\/manifest\.json doesn't match the manifest's schema:/);
		for (const field of ["files[0].sha256", "files[1].file", "files[1].commit"]) {
			expect(failures[0]).toContain(field);
		}
	});

	test("fails on a manifest that isn't JSON", () => {
		const root = fixture([prompt]);
		writeFileSync(join(root, "vectors/manifest.json"), "{ files: [] }");
		const failures = vectorFailures(root);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/^vectors\/manifest\.json isn't valid JSON: /);
	});

	test("fails without a manifest", () => {
		const root = fixture([prompt]);
		rmSync(join(root, "vectors/manifest.json"));
		expect(vectorFailures(root)).toStrictEqual(["vectors/manifest.json is missing."]);
	});
});

describe("readVerifiedVectors", () => {
	test("returns the bytes of every file, keyed by its manifest path", () => {
		const files = readVerifiedVectors(fixture([prompt, results]));
		expect([...files.keys()]).toStrictEqual([prompt.file, results.file]);
		expect(new TextDecoder().decode(files.get(prompt.file))).toBe(prompt.bytes);
	});

	test("throws with every failure, so no case runs on a file that doesn't match", () => {
		const root = fixture(
			[prompt],
			[entry(prompt.file, prompt.bytes), entry(results.file, results.bytes)],
		);
		expect(() => readVerifiedVectors(root)).toThrow(
			`The vector files don't match vectors/manifest.json:\n- vectors/${results.file} is missing, but vectors/manifest.json lists it.`,
		);
	});
});

describe("the committed vectors", () => {
	test("match the manifest", () => {
		expect(vectorFailures(repoRoot)).toStrictEqual([]);
	});

	test("are binary to git, so no checkout converts their line endings", () => {
		const file = "vectors/acvp/ML-DSA-sigVer-FIPS204/prompt.json";
		const result = spawnSync(
			"git",
			["check-attr", "text", "diff", "linguist-generated", "--", file],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		expect(result.stdout).toBe(
			`${file}: text: unset\n${file}: diff: unset\n${file}: linguist-generated: set\n`,
		);
	});

	test("leave the manifest's own diff visible", () => {
		const file = "vectors/manifest.json";
		const result = spawnSync(
			"git",
			["check-attr", "text", "diff", "linguist-generated", "--", file],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);
		expect(result.stdout).toBe(
			`${file}: text: unspecified\n${file}: diff: unspecified\n${file}: linguist-generated: unspecified\n`,
		);
	});
});

describe("provenanceFailures", () => {
	const encoder = new TextEncoder();
	const urlOf = (file: string): string =>
		`https://raw.githubusercontent.com/${repository}/${commit}/gen-val/json-files/${file}`;

	/** A fetch that serves `served`, keyed by URL, and fails for any other URL. */
	function serving(served: ReadonlyMap<string, string>): (url: string) => Promise<Uint8Array> {
		return async (url) => {
			const text = served.get(url);
			if (text === undefined) {
				throw new Error(`404 Not Found for ${url}`);
			}
			return encoder.encode(text);
		};
	}

	test("passes when each URL serves the committed bytes", async () => {
		const root = fixture([prompt, results]);
		const served = new Map([
			[urlOf(prompt.file), prompt.bytes],
			[urlOf(results.file), results.bytes],
		]);
		expect(await provenanceFailures(root, serving(served))).toStrictEqual([]);
	});

	test("names a file whose URL serves other bytes, and one whose fetch fails", async () => {
		const root = fixture([prompt, results]);
		const served = new Map([[urlOf(prompt.file), "{}\n"]]);
		expect(await provenanceFailures(root, serving(served))).toStrictEqual([
			`${urlOf(prompt.file)} serves bytes with SHA-256 ${sha256("{}\n")}, but vectors/${prompt.file} has SHA-256 ${sha256(prompt.bytes)}.`,
			`Fetching ${urlOf(results.file)} failed: 404 Not Found for ${urlOf(results.file)}`,
		]);
	});

	test("compares nothing when the offline check fails", async () => {
		const root = fixture(
			[prompt],
			[entry(prompt.file, prompt.bytes), entry(results.file, results.bytes)],
		);
		expect(await provenanceFailures(root, serving(new Map()))).toStrictEqual([
			`vectors/${results.file} is missing, but vectors/manifest.json lists it.`,
		]);
	});
});
