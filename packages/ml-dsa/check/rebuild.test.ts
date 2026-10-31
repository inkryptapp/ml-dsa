import { describe, expect, test } from "vite-plus/test";

import { nativeSystem, plannedBuilds, rebuildFailures, type BuildResult } from "./rebuild.ts";

const file = "packages/ml-dsa/wasm/mldsa.wasm";
const committedHash = "a".repeat(64);

const native: BuildResult = {
	system: "aarch64-linux",
	emulated: false,
	storePath: "/nix/store/0123456789abcdfghijklmnpqrsvwxyz-mldsa-wasm",
	hash: committedHash,
};
const emulated: BuildResult = {
	system: "x86_64-linux",
	emulated: true,
	storePath: "/nix/store/zyxwvsrqpnmlkjihgfdcba9876543210-mldsa-wasm",
	hash: committedHash,
};

describe("nativeSystem", () => {
	test("maps Node's architecture names to the build image's systems", () => {
		expect([nativeSystem("arm64"), nativeSystem("x64"), nativeSystem("riscv64")]).toStrictEqual([
			"aarch64-linux",
			"x86_64-linux",
			undefined,
		]);
	});
});

describe("plannedBuilds", () => {
	test("adds an emulated x86_64 build on an arm64 host", () => {
		expect(plannedBuilds("aarch64-linux", false)).toStrictEqual([
			{ system: "aarch64-linux", emulated: false },
			{ system: "x86_64-linux", emulated: true },
		]);
	});

	test("builds only the native system when asked, as CI does", () => {
		expect(plannedBuilds("aarch64-linux", true)).toStrictEqual([
			{ system: "aarch64-linux", emulated: false },
		]);
	});

	test("never emulates on an x86_64 host", () => {
		expect(plannedBuilds("x86_64-linux", false)).toStrictEqual([
			{ system: "x86_64-linux", emulated: false },
		]);
	});
});

describe("rebuildFailures", () => {
	test("passes when every build equals the committed module", () => {
		expect(rebuildFailures(file, committedHash, [native, emulated])).toStrictEqual([]);
	});

	test("names each build that differs, and the command that copies it into the repo", () => {
		const changed = { ...emulated, hash: "b".repeat(64) };
		expect(rebuildFailures(file, committedHash, [native, changed])).toStrictEqual([
			`The x86_64-linux build differs from ${file}. If you changed the build on purpose, copy the build into the repo with \`scripts/nix store cat ${emulated.storePath}/mldsa.wasm > ${file}\` and run the check again. Otherwise the build isn't reproducible.`,
		]);
	});

	test("fails once, with the native build to copy, when the repo has no committed module", () => {
		expect(rebuildFailures(file, undefined, [native, emulated])).toStrictEqual([
			`The repo has no ${file}. Copy the aarch64-linux build into the repo with \`scripts/nix store cat ${native.storePath}/mldsa.wasm > ${file}\`, run the check again, and commit the module once every build equals it.`,
		]);
	});
});
