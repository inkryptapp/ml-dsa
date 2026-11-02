/**
 * The vector manifest, `vectors/manifest.json`. It lists each vector file
 * with its source repository, pinned commit, path, URL, and SHA-256. The
 * check command and the vector tests read no vector file that doesn't match
 * it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { z } from "zod";

const vectorFolder = "vectors";
const manifestPath = `${vectorFolder}/manifest.json`;

// A relative path whose names don't start with a dot, so it can't climb out
// of its folder or name a hidden file.
const relativePath = z
	.string()
	.regex(
		/^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/,
		"Expected a relative path of names that don't start with a dot",
	);

/** One file of the manifest. */
interface ManifestEntry {
	/** The file's path in the `vectors` folder. */
	readonly file: string;
	/** The source repository on GitHub, as `owner/name`. */
	readonly repository: string;
	/** The commit of the source repository that the file is pinned at. */
	readonly commit: string;
	/** The file's path in the source repository. */
	readonly path: string;
	/** The URL that serves the file's bytes at the commit. */
	readonly url: string;
	readonly sha256: string;
}

const Manifest = z.strictObject({
	files: z.array(
		z.strictObject({
			file: relativePath,
			repository: z.string().regex(/^[\w-]+\/[\w.-]+$/, "Expected owner/name"),
			commit: z.string().regex(/^[0-9a-f]{40}$/, "Expected a full commit SHA in lowercase hex"),
			path: relativePath,
			url: z.string(),
			sha256: z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 in lowercase hex"),
		}),
	),
});

/** The URL that serves an entry's bytes at its commit. */
function rawUrl(entry: ManifestEntry): string {
	return `https://raw.githubusercontent.com/${entry.repository}/${entry.commit}/${entry.path}`;
}

/** The `message` of a thrown value, which needn't be an `Error`. */
function messageOf(error: unknown): string {
	const message: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
	return typeof message === "string" ? message : "it threw a value with no message.";
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The path of every file under `folder`, relative to it, with `/` between names, in sorted order. */
function filesUnder(folder: string): readonly string[] {
	return readdirSync(folder, { recursive: true, withFileTypes: true })
		.filter((entry) => !entry.isDirectory())
		.map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
		.toSorted();
}

/**
 * What the manifest check found: the manifest's entries, the bytes of each
 * file that matches its entry, keyed by its `file`, and one message per
 * failure.
 */
interface CheckedVectors {
	readonly entries: readonly ManifestEntry[];
	readonly files: ReadonlyMap<string, Uint8Array>;
	readonly failures: readonly string[];
}

/**
 * Reads and parses the manifest under `root`.
 *
 * @returns The entries, or the failure that stops every other check.
 */
function readManifest(root: string): readonly ManifestEntry[] | string {
	const path = join(root, manifestPath);
	if (!existsSync(path)) {
		return `${manifestPath} is missing.`;
	}
	let json: unknown = undefined;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return `${manifestPath} isn't valid JSON: ${messageOf(error)}`;
	}
	const parsed = Manifest.safeParse(json);
	if (!parsed.success) {
		return `${manifestPath} doesn't match the manifest's schema:\n${z.prettifyError(parsed.error)}`;
	}
	return parsed.data.files;
}

function checkVectors(root: string): CheckedVectors {
	const folder = join(root, vectorFolder);
	const entries = readManifest(root);
	if (typeof entries === "string") {
		return { entries: [], files: new Map(), failures: [entries] };
	}
	const files = new Map<string, Uint8Array>();
	const failures: string[] = [];
	const listed = new Set<string>();
	for (const entry of entries) {
		const { file, url, sha256: expected } = entry;
		if (listed.has(file)) {
			failures.push(`${manifestPath} lists ${file} more than once.`);
			continue;
		}
		listed.add(file);
		if (url !== rawUrl(entry)) {
			failures.push(
				`${manifestPath} gives ${url} as the URL of ${file}, but its repository, commit, and path give ${rawUrl(entry)}.`,
			);
		}
		const path = join(folder, file);
		if (!existsSync(path)) {
			failures.push(`${vectorFolder}/${file} is missing, but ${manifestPath} lists it.`);
			continue;
		}
		const bytes = readFileSync(path);
		const actual = sha256(bytes);
		if (actual === expected) {
			files.set(file, bytes);
		} else {
			failures.push(
				`${vectorFolder}/${file} has SHA-256 ${actual}, but ${manifestPath} gives ${expected}. Restore the file from ${url}, or update the manifest and every pinned count with it.`,
			);
		}
	}
	for (const file of filesUnder(folder)) {
		if (file !== "manifest.json" && !listed.has(file)) {
			failures.push(
				`${vectorFolder}/${file} isn't in ${manifestPath}. Add it to the manifest, or delete it.`,
			);
		}
	}
	return { entries, files, failures };
}

/**
 * Checks every file in the `vectors` folder under `root` against the
 * manifest.
 *
 * @returns One message per failure, each naming the file and what is wrong.
 */
export function vectorFailures(root: string): readonly string[] {
	return checkVectors(root).failures;
}

/**
 * Checks every vector file against the manifest, then returns the bytes it
 * checked, so a caller parses exactly the bytes whose hashes matched.
 *
 * @returns The bytes of each file, keyed by its path in the `vectors` folder.
 * @throws Error that lists every failure, if any file fails.
 */
export function readVerifiedVectors(root: string): ReadonlyMap<string, Uint8Array> {
	const { files, failures } = checkVectors(root);
	if (failures.length > 0) {
		throw new Error(
			`The vector files don't match ${manifestPath}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
		);
	}
	return files;
}

/**
 * The SHA-256 of each file that the manifest lists, keyed by the file's path
 * in the `vectors` folder. The package checks use it to find a vector file in
 * the tarball.
 *
 * @throws Error when the manifest is missing or doesn't match its schema.
 */
export function manifestHashes(root: string): ReadonlyMap<string, string> {
	const entries = readManifest(root);
	if (typeof entries === "string") {
		throw new Error(entries);
	}
	return new Map(entries.map((entry) => [entry.file, entry.sha256]));
}

/**
 * Fetches each file's URL and compares the served bytes with the committed
 * file. It fetches only if the offline check passes, so each committed file
 * already has its manifest SHA-256, and the comparison checks the served
 * bytes against that hash.
 *
 * @param fetchBytes Returns the bytes that a URL serves, or throws.
 * @returns One message per failure, each naming the URL or the file.
 */
export async function provenanceFailures(
	root: string,
	fetchBytes: (url: string) => Promise<Uint8Array>,
): Promise<readonly string[]> {
	const { entries, failures } = checkVectors(root);
	if (failures.length > 0) {
		return failures;
	}
	const mismatches: string[] = [];
	for (const { file, url, sha256: expected } of entries) {
		let served: Uint8Array | undefined = undefined;
		try {
			served = await fetchBytes(url);
		} catch (error) {
			mismatches.push(`Fetching ${url} failed: ${messageOf(error)}`);
			continue;
		}
		const actual = sha256(served);
		if (actual !== expected) {
			mismatches.push(
				`${url} serves bytes with SHA-256 ${actual}, but ${vectorFolder}/${file} has SHA-256 ${expected}.`,
			);
		}
	}
	return mismatches;
}
