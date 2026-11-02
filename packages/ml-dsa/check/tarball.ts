/**
 * Reads the npm tarball that `npm pack` writes, and compares the tarballs that
 * two systems packed. `npm pack` writes a gzipped ustar archive with one
 * `package/` folder. Each system's zlib can compress the same archive to other
 * bytes, so two tarballs pass when their bytes or their archives are
 * identical.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { System } from "./rebuild.ts";

/** Bytes that aren't the gzipped ustar archive that `npm pack` writes. */
export class TarballFormatError extends Error {}

/** Each file of a tarball, keyed by its path relative to the package root. */
export type TarballFiles = ReadonlyMap<string, Uint8Array>;

const blockBytes = 512;
const packageFolder = "package/";

function messageOf(error: unknown): string {
	const message: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "message") : undefined;
	return typeof message === "string" ? message : "it threw a value with no message.";
}

/** The text of a header field, up to its first zero byte. */
function field(header: Uint8Array, start: number, length: number): string {
	const bytes = header.subarray(start, start + length);
	const end = bytes.indexOf(0);
	return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
}

/** The number in an octal header field. */
function octal(header: Uint8Array, start: number, length: number, name: string): number {
	const text = field(header, start, length).trim();
	if (!/^[0-7]+$/.test(text)) {
		throw new TarballFormatError(`A header's ${name} field holds ${JSON.stringify(text)}.`);
	}
	return Number.parseInt(text, 8);
}

/** Checks the header checksum, which sums the header's bytes with the checksum field read as spaces. */
function checkChecksum(header: Uint8Array): void {
	const expected = octal(header, 148, 8, "checksum");
	let sum = 0;
	for (let index = 0; index < blockBytes; index += 1) {
		sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	if (sum !== expected) {
		throw new TarballFormatError(
			`A header's checksum is ${String(expected)}, but its bytes sum to ${String(sum)}.`,
		);
	}
}

/**
 * The file name that the check command gives the tarball that it packed on
 * `system`, such as `ml-dsa-x86_64-linux.tgz`.
 */
export function packedTarballName(system: System): string {
	return `ml-dsa-${system}.tgz`;
}

function gunzip(gzipped: Uint8Array): Buffer {
	try {
		return gunzipSync(gzipped);
	} catch (error) {
		throw new TarballFormatError(`It isn't gzip data: ${messageOf(error)}`);
	}
}

/** Reads the files of the archive inside a tarball. */
function archiveFiles(archive: Uint8Array): TarballFiles {
	const files = new Map<string, Uint8Array>();
	let offset = 0;
	for (;;) {
		if (offset + blockBytes > archive.length) {
			throw new TarballFormatError("The archive ends before its end-of-archive block.");
		}
		const header = archive.subarray(offset, offset + blockBytes);
		if (header.every((byte) => byte === 0)) {
			return files;
		}
		checkChecksum(header);
		const name = field(header, 0, 100);
		const prefix = field(header, 345, 155);
		const path = prefix === "" ? name : `${prefix}/${name}`;
		const type = field(header, 156, 1);
		const size = octal(header, 124, 12, "size");
		offset += blockBytes;
		if (offset + size > archive.length) {
			throw new TarballFormatError(`The archive ends inside ${path}.`);
		}
		if (type === "0" || type === "") {
			if (!path.startsWith(packageFolder)) {
				throw new TarballFormatError(`It holds ${path}, which isn't under ${packageFolder}.`);
			}
			const file = path.slice(packageFolder.length);
			if (files.has(file)) {
				throw new TarballFormatError(`It holds ${path} twice.`);
			}
			files.set(file, archive.subarray(offset, offset + size));
		} else if (type !== "5") {
			throw new TarballFormatError(
				`It holds ${path} as an entry of type ${JSON.stringify(type)}, which isn't a file or a folder.`,
			);
		}
		offset += Math.ceil(size / blockBytes) * blockBytes;
	}
}

/**
 * Reads the files of a tarball. Folder entries are skipped, and any other
 * kind of entry, such as a link, fails.
 *
 * @throws TarballFormatError when the bytes aren't such a tarball.
 */
export function readTarball(gzipped: Uint8Array): TarballFiles {
	return archiveFiles(gunzip(gzipped));
}

/** A tarball that the check packed, and the system that packed it. */
export interface PackedTarball {
	readonly system: System;
	readonly bytes: Uint8Array;
}

/** How a comparison of two tarballs ended: a line for the log, or one message per failure. */
export type TarballComparison =
	| { readonly passed: true; readonly summary: string }
	| { readonly passed: false; readonly failures: readonly string[] };

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	return Buffer.compare(first, second) === 0;
}

/** A packed tarball's archive, after its gzip layer comes off. */
interface Unpacked {
	readonly system: System;
	readonly archive: Uint8Array;
}

/** One message per file that only one of the two archives holds or that differs between them. */
function fileDifferences(first: Unpacked, second: Unpacked): readonly string[] {
	const firstFiles = archiveFiles(first.archive);
	const secondFiles = archiveFiles(second.archive);
	const paths = [...new Set([...firstFiles.keys(), ...secondFiles.keys()])].toSorted();
	return paths.flatMap((path) => {
		const a = firstFiles.get(path);
		const b = secondFiles.get(path);
		if (a === undefined || b === undefined) {
			const [holder, lacker] = a === undefined ? [second, first] : [first, second];
			return [
				`The ${lacker.system} tarball lacks ${path}, which the ${holder.system} tarball holds.`,
			];
		}
		if (sameBytes(a, b)) {
			return [];
		}
		return [
			`${path} differs between the tarballs: SHA-256 ${sha256(a)} from ${first.system}, and ${sha256(b)} from ${second.system}.`,
		];
	});
}

/**
 * Compares two tarballs. They pass when their bytes are identical, or when
 * only their gzip layer differs and the archives inside are identical.
 */
export function compareTarballs(first: PackedTarball, second: PackedTarball): TarballComparison {
	const both = `${first.system} and ${second.system} tarballs`;
	if (sameBytes(first.bytes, second.bytes)) {
		return { passed: true, summary: `The ${both} are byte-identical.` };
	}
	try {
		const firstArchive = { system: first.system, archive: gunzip(first.bytes) };
		const secondArchive = { system: second.system, archive: gunzip(second.bytes) };
		if (sameBytes(firstArchive.archive, secondArchive.archive)) {
			return {
				passed: true,
				summary: `The ${both} hold identical archives, and only their gzip layer differs.`,
			};
		}
		const failures = fileDifferences(firstArchive, secondArchive);
		return {
			passed: false,
			failures:
				failures.length > 0
					? failures
					: [
							`The archives in the ${both} hold identical files, but their tar headers differ, such as in a file's mode, owner, or time, or in the order of the files.`,
						],
		};
	} catch (error) {
		if (!(error instanceof TarballFormatError)) {
			throw error;
		}
		return {
			passed: false,
			failures: [`The tarballs differ, and the check can't read one of them. ${error.message}`],
		};
	}
}
