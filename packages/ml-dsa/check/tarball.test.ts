import { gzipSync } from "node:zlib";

import { describe, expect, test } from "vite-plus/test";

import { compareTarballs, readTarball, TarballFormatError, type PackedTarball } from "./tarball.ts";

interface Entry {
	readonly path: string;
	readonly bytes?: string;
	readonly type?: string;
	readonly mode?: string;
}

/** Writes the checksum of a ustar header, which sums its bytes with the checksum field read as spaces. */
function writeChecksum(block: Buffer): void {
	block.write(" ".repeat(8), 148, "ascii");
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

/** A ustar header for `entry`, with its checksum. */
function header({ path, bytes = "", type = "0", mode = "0000644" }: Entry): Buffer {
	const block = Buffer.alloc(512);
	block.write(path, 0, 100, "utf8");
	block.write(`${mode}\0`, 100, "ascii");
	block.write(`${Buffer.byteLength(bytes).toString(8).padStart(11, "0")}\0`, 124, "ascii");
	block.write("00000000000\0", 136, "ascii");
	block.write(type, 156, "ascii");
	block.write("ustar\u000000", 257, "ascii");
	writeChecksum(block);
	return block;
}

/** The archive of `entries`, with the two zero blocks that end it. */
function archive(entries: readonly Entry[]): Buffer {
	return Buffer.concat([
		...entries.flatMap((entry) => {
			const data = Buffer.from(entry.bytes ?? "");
			const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
			return [header(entry), data, padding];
		}),
		Buffer.alloc(1024),
	]);
}

function tarball(entries: readonly Entry[], level = 9): Buffer {
	return gzipSync(archive(entries), { level });
}

const entries: readonly Entry[] = [
	{ path: "package/package.json", bytes: '{"name":"ml-dsa"}' },
	{ path: "package/dist", type: "5" },
	{ path: "package/dist/index.js", bytes: "x".repeat(600) },
];

describe("the tarball reader", () => {
	test("reads each file by its path in the package, and skips folders", () => {
		const files = readTarball(tarball(entries));
		expect([...files.keys()]).toStrictEqual(["package.json", "dist/index.js"]);
		expect(Buffer.from(files.get("dist/index.js") ?? []).toString()).toBe("x".repeat(600));
	});

	test.each([
		["bytes that aren't gzip data", Buffer.from("not gzip"), /^It isn't gzip data/],
		[
			"an archive without its end-of-archive block",
			gzipSync(archive(entries).subarray(0, 1536)),
			/^The archive ends before its end-of-archive block\.$/,
		],
		[
			"a file outside the package folder",
			tarball([{ path: "other/index.js", bytes: "x" }]),
			/^It holds other\/index\.js, which isn't under package\/\.$/,
		],
		[
			"a file that appears twice",
			tarball([entries[0] ?? { path: "" }, entries[0] ?? { path: "" }]),
			/^It holds package\/package\.json twice\.$/,
		],
		[
			"a symbolic link",
			tarball([{ path: "package/link", type: "2" }]),
			/^It holds package\/link as an entry of type "2", which isn't a file or a folder\.$/,
		],
	])("rejects %s", (_name, bytes, message) => {
		expect(() => readTarball(bytes)).toThrow(TarballFormatError);
		expect(() => readTarball(bytes)).toThrow(message);
	});

	test("rejects an archive that ends inside a file", () => {
		const cut = archive(entries).subarray(0, 512 * 4 + 100);
		expect(() => readTarball(gzipSync(cut))).toThrow(
			/^The archive ends inside package\/dist\/index\.js\.$/,
		);
	});

	test("rejects a size field that isn't an octal number", () => {
		const broken = archive(entries);
		broken.write("12345678901\0", 124, "ascii");
		writeChecksum(broken.subarray(0, 512));
		expect(() => readTarball(gzipSync(broken))).toThrow(
			/^A header's size field holds "12345678901"\.$/,
		);
	});

	test("rejects a header whose checksum doesn't match its bytes", () => {
		const broken = archive(entries);
		broken[0] = 0x71;
		expect(() => readTarball(gzipSync(broken))).toThrow(/^A header's checksum is \d+/);
	});
});

describe("the tarball comparison", () => {
	const first: PackedTarball = { system: "aarch64-linux", bytes: tarball(entries) };

	test("passes byte-identical tarballs", () => {
		expect(compareTarballs(first, { ...first, system: "x86_64-linux" })).toStrictEqual({
			passed: true,
			summary: "The aarch64-linux and x86_64-linux tarballs are byte-identical.",
		});
	});

	test("passes identical archives whose gzip layer differs", () => {
		const second: PackedTarball = { system: "x86_64-linux", bytes: tarball(entries, 1) };
		expect(Buffer.compare(first.bytes, second.bytes)).not.toBe(0);
		expect(compareTarballs(first, second)).toStrictEqual({
			passed: true,
			summary:
				"The aarch64-linux and x86_64-linux tarballs hold identical archives, and only their gzip layer differs.",
		});
	});

	test("fails identical files whose tar headers differ", () => {
		const executable = entries.map((entry) =>
			entry.path === "package/dist/index.js" ? { ...entry, mode: "0000755" } : entry,
		);
		expect(
			compareTarballs(first, { system: "x86_64-linux", bytes: tarball(executable) }),
		).toStrictEqual({
			passed: false,
			failures: [
				"The archives in the aarch64-linux and x86_64-linux tarballs hold identical files, but their tar headers differ, such as in a file's mode, owner, or time, or in the order of the files.",
			],
		});
	});

	test("names each file that differs or that only one tarball holds", () => {
		const second: PackedTarball = {
			system: "x86_64-linux",
			bytes: tarball([
				{ path: "package/package.json", bytes: '{"name":"other"}' },
				{ path: "package/dist/workerd.js", bytes: "y" },
			]),
		};
		const comparison = compareTarballs(first, second);
		const failures = comparison.passed ? [] : comparison.failures;
		expect(failures).toHaveLength(3);
		expect(failures[0]).toBe(
			"The x86_64-linux tarball lacks dist/index.js, which the aarch64-linux tarball holds.",
		);
		expect(failures[1]).toBe(
			"The aarch64-linux tarball lacks dist/workerd.js, which the x86_64-linux tarball holds.",
		);
		expect(failures[2]).toMatch(
			/^package\.json differs between the tarballs: SHA-256 [0-9a-f]{64} from aarch64-linux, and [0-9a-f]{64} from x86_64-linux\.$/,
		);
	});

	test("fails tarballs that differ when one can't be read", () => {
		expect(
			compareTarballs(first, { system: "x86_64-linux", bytes: Buffer.from("not gzip") }),
		).toStrictEqual({
			passed: false,
			failures: [
				expect.stringMatching(
					/^The tarballs differ, and the check can't read one of them\. It isn't gzip data: /,
				),
			],
		});
	});
});
