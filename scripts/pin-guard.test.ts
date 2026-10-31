import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vite-plus/test";

import { CommandFailed } from "./check-step.ts";
import { pinGuardFailures, readPinState, submodulePath, type PinState } from "./pin-guard.ts";

const pin = "834a90d5e846ffa1e1611bd24e160bb2e9b86d35";
const other = "1111111111111111111111111111111111111111";

function statement(tag: string, commit: string): string {
	return `# ml-dsa\n\nThis package is an independent build of mldsa-native, not a NIST or pq-code-package release. It builds from mldsa-native ${tag}, commit \`${commit}\`.\n`;
}

const healthy: PinState = {
	gitlink: pin,
	head: pin,
	changes: [],
	stableTags: new Map([
		["v1.0.0", other],
		["v2.0.0", pin],
	]),
	mldsaNative: { tag: "v2.0.0", commit: pin },
	readme: statement("v2.0.0", pin),
};

describe("pinGuardFailures", () => {
	test("passes a clean submodule at a stable tag that the field and the README name", () => {
		expect(pinGuardFailures(healthy)).toStrictEqual([]);
	});

	test("fails when the repo records no gitlink", () => {
		expect(pinGuardFailures({ ...healthy, gitlink: undefined })).toStrictEqual([
			"The repo records no gitlink for vendor/mldsa-native, so nothing pins upstream.",
		]);
	});

	test("fails when the submodule isn't initialized", () => {
		expect(pinGuardFailures({ ...healthy, head: undefined })).toStrictEqual([
			"vendor/mldsa-native isn't initialized, so the guard can't read upstream's tags. Run `git submodule update --init`.",
		]);
	});

	test("fails when the submodule sits at another commit than the gitlink", () => {
		expect(pinGuardFailures({ ...healthy, head: other })).toStrictEqual([
			`vendor/mldsa-native is checked out at ${other}, but the gitlink records ${pin}. Run \`git submodule update\`, or commit the gitlink you mean to pin.`,
		]);
	});

	test("fails on changed, untracked, and ignored files, and lists them", () => {
		const changes = [" M mldsa/src/sign.c", "?? extra.c", "!! extra.o"];
		expect(pinGuardFailures({ ...healthy, changes })).toStrictEqual([
			"vendor/mldsa-native has changes or untracked files, ignored ones included, and every file in it must equal the pin:\n   M mldsa/src/sign.c\n  ?? extra.c\n  !! extra.o",
		]);
	});

	test("fails when the field is missing or has another shape", () => {
		for (const mldsaNative of [
			undefined,
			"v2.0.0",
			{ tag: "v2.0.0" },
			{ tag: "v2.0.0", commit: "834a90d" },
		]) {
			expect(pinGuardFailures({ ...healthy, mldsaNative })).toStrictEqual([
				'packages/ml-dsa/package.json must hold "mldsaNative": { "tag": "vX.Y.Z", "commit": "<40 hex digits>" }.',
			]);
		}
	});

	test("ignores other keys in the field", () => {
		const mldsaNative = { tag: "v2.0.0", commit: pin, url: "https://example.com" };
		expect(pinGuardFailures({ ...healthy, mldsaNative })).toStrictEqual([]);
	});

	test("fails when the README has no independent-build statement", () => {
		for (const readme of [undefined, "# ml-dsa\n"]) {
			expect(pinGuardFailures({ ...healthy, readme })).toStrictEqual([
				'packages/ml-dsa/README.md has no independent-build statement that names the pin: "This package is an independent build of mldsa-native, not a NIST or pq-code-package release. It builds from mldsa-native vX.Y.Z, commit `<commit>`."',
			]);
		}
	});

	test("fails when the field or the README names another commit than the gitlink", () => {
		expect(
			pinGuardFailures({ ...healthy, mldsaNative: { tag: "v1.0.0", commit: other } }),
		).toStrictEqual([
			`The mldsaNative field in packages/ml-dsa/package.json names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
		]);
		expect(pinGuardFailures({ ...healthy, readme: statement("v1.0.0", other) })).toStrictEqual([
			`The independent-build statement in packages/ml-dsa/README.md names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
		]);
	});

	test("rejects a suffixed tag in the field and the README", () => {
		const state: PinState = {
			...healthy,
			mldsaNative: { tag: "v2.0.0-rc1", commit: pin },
			readme: statement("v2.0.0-rc1", pin),
		};
		expect(pinGuardFailures(state)).toStrictEqual([
			"The mldsaNative field in packages/ml-dsa/package.json names v2.0.0-rc1, which isn't a stable tag of the form vX.Y.Z.",
			"The independent-build statement in packages/ml-dsa/README.md names v2.0.0-rc1, which isn't a stable tag of the form vX.Y.Z.",
		]);
	});

	test("reports a suffixed tag and a wrong commit in the same claim", () => {
		expect(
			pinGuardFailures({ ...healthy, mldsaNative: { tag: "v2.0.0-rc1", commit: other } }),
		).toStrictEqual([
			"The mldsaNative field in packages/ml-dsa/package.json names v2.0.0-rc1, which isn't a stable tag of the form vX.Y.Z.",
			`The mldsaNative field in packages/ml-dsa/package.json names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
		]);
	});

	test("treats a tag that points at another commit as moved", () => {
		const state: PinState = {
			...healthy,
			stableTags: new Map([
				["v2.0.0", other],
				["v2.0.1", pin],
			]),
		};
		const moved = (claimant: string): string =>
			`${claimant} names v2.0.0 at ${pin}, but the tag points at ${other}. Upstream moved the tag, or the commit it names is wrong. Update the tags with \`git -C vendor/mldsa-native fetch --force --prune --prune-tags origin\` to see upstream's.`;
		expect(pinGuardFailures(state)).toStrictEqual([
			moved("The mldsaNative field in packages/ml-dsa/package.json"),
			moved("The independent-build statement in packages/ml-dsa/README.md"),
		]);
	});

	test("treats a deleted tag as moved", () => {
		const state: PinState = {
			...healthy,
			stableTags: new Map([
				["v1.0.0", other],
				["v2.0.1", pin],
			]),
		};
		const deleted = (claimant: string): string =>
			`${claimant} names v2.0.0, which isn't among the submodule's fetched tags. Upstream deleted the tag, which counts as moved, or the tags weren't fetched. Update them with \`git -C vendor/mldsa-native fetch --force --prune --prune-tags origin\`.`;
		expect(pinGuardFailures(state)).toStrictEqual([
			deleted("The mldsaNative field in packages/ml-dsa/package.json"),
			deleted("The independent-build statement in packages/ml-dsa/README.md"),
		]);
	});

	test("fails when the gitlink is no stable tag's commit", () => {
		const state: PinState = {
			...healthy,
			stableTags: new Map([["v1.0.0", other]]),
			mldsaNative: { tag: "v1.0.0", commit: other },
			readme: statement("v1.0.0", other),
		};
		expect(pinGuardFailures({ ...state, gitlink: other, head: other })).toStrictEqual([]);
		expect(pinGuardFailures(state)).toStrictEqual([
			`The gitlink ${pin} isn't the commit of any stable tag of the form vX.Y.Z among the submodule's fetched tags. Pin a stable upstream release, or update the tags with \`git -C vendor/mldsa-native fetch --force --prune --prune-tags origin\`.`,
			`The mldsaNative field in packages/ml-dsa/package.json names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
			`The independent-build statement in packages/ml-dsa/README.md names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
		]);
	});

	test("fails when the field and the README name different tags of the pin's commit", () => {
		const state: PinState = {
			...healthy,
			stableTags: new Map([
				["v2.0.0", pin],
				["v2.0.1", pin],
			]),
			readme: statement("v2.0.1", pin),
		};
		expect(pinGuardFailures(state)).toStrictEqual([
			"The field and every independent-build statement must name the same tag. The mldsaNative field in packages/ml-dsa/package.json names v2.0.0. The independent-build statement in packages/ml-dsa/README.md names v2.0.1.",
		]);
	});

	test("checks every independent-build statement in the README", () => {
		const readme = `${statement("v2.0.0", pin)}\n${statement("v1.0.0", other)}`;
		expect(pinGuardFailures({ ...healthy, readme })).toStrictEqual([
			`The independent-build statement in packages/ml-dsa/README.md names commit ${other}, but the gitlink records ${pin}. Update the field and the README when the pin moves.`,
		]);
	});
});

describe("readPinState", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pin-guard-"));
	afterAll(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	// The settings keep the user's global git config, such as commit signing,
	// out of the test, and let `submodule add` clone from a local path.
	const settings = [
		"protocol.file.allow=always",
		"user.name=test",
		"user.email=test@example.com",
		"commit.gpgSign=false",
		"tag.gpgSign=false",
	].flatMap((setting) => ["-c", setting]);

	function git(cwd: string, ...args: string[]): string {
		const result = spawnSync("git", [...settings, ...args], { cwd, encoding: "utf8" });
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		}
		return result.stdout.trim();
	}

	function repo(name: string): string {
		const path = join(scratch, name);
		mkdirSync(path);
		git(path, "init", "--quiet", "--initial-branch=main");
		return path;
	}

	// The stable tag is annotated, so its object isn't a commit. The suffixed
	// tag isn't stable, so the reader skips it.
	const upstream = repo("upstream");
	writeFileSync(join(upstream, "README.md"), "upstream\n");
	writeFileSync(join(upstream, ".gitignore"), "*.o\n");
	git(upstream, "add", ".");
	git(upstream, "commit", "--quiet", "-m", "release");
	git(upstream, "tag", "--annotate", "-m", "v2.0.0", "v2.0.0");
	const tagged = git(upstream, "rev-parse", "HEAD");
	git(upstream, "commit", "--quiet", "--allow-empty", "-m", "candidate");
	git(upstream, "tag", "v2.0.1-rc1");

	function superproject(name: string): string {
		const path = repo(name);
		git(path, "submodule", "--quiet", "add", upstream, submodulePath);
		git(join(path, submodulePath), "checkout", "--quiet", tagged);
		mkdirSync(join(path, "packages/ml-dsa"), { recursive: true });
		writeFileSync(
			join(path, "packages/ml-dsa/package.json"),
			JSON.stringify({ name: "ml-dsa", mldsaNative: { tag: "v2.0.0", commit: tagged } }),
		);
		writeFileSync(join(path, "packages/ml-dsa/README.md"), statement("v2.0.0", tagged));
		git(path, "add", ".");
		git(path, "commit", "--quiet", "-m", "pin");
		return path;
	}

	test("reads a clean submodule and peels the annotated tag to its commit", () => {
		const state = readPinState(superproject("clean"));
		expect(state).toStrictEqual({
			gitlink: tagged,
			head: tagged,
			changes: [],
			stableTags: new Map([["v2.0.0", tagged]]),
			mldsaNative: { tag: "v2.0.0", commit: tagged },
			readme: statement("v2.0.0", tagged),
		});
		expect(pinGuardFailures(state)).toStrictEqual([]);
	});

	test("reads no gitlink from a repo without the submodule", () => {
		expect(pinGuardFailures(readPinState(repo("no-submodule")))).toStrictEqual([
			"The repo records no gitlink for vendor/mldsa-native, so nothing pins upstream.",
		]);
	});

	test("reports changed, untracked, and ignored files inside the submodule", () => {
		const path = superproject("changed");
		writeFileSync(join(path, submodulePath, "README.md"), "changed\n");
		writeFileSync(join(path, submodulePath, "extra.c"), "");
		writeFileSync(join(path, submodulePath, "extra.o"), "");
		expect(readPinState(path).changes).toStrictEqual([" M README.md", "?? extra.c", "!! extra.o"]);
	});

	test("reads a package.json that isn't valid JSON as a missing field", () => {
		const path = superproject("invalid-json");
		writeFileSync(join(path, "packages/ml-dsa/package.json"), "{");
		expect(pinGuardFailures(readPinState(path))).toStrictEqual([
			'packages/ml-dsa/package.json must hold "mldsaNative": { "tag": "vX.Y.Z", "commit": "<40 hex digits>" }.',
		]);
	});

	test("reports a git failure as a failure of the check step", () => {
		const path = superproject("blob-tag");
		const submodule = join(path, submodulePath);
		git(submodule, "tag", "v9.9.9", git(submodule, "rev-parse", "HEAD:README.md"));
		expect(() => readPinState(path)).toThrow(CommandFailed);
		expect(() => readPinState(path)).toThrow("`git rev-parse refs/tags/v9.9.9^{commit}` failed");
	});

	test("reads a submodule that isn't initialized", () => {
		const path = superproject("deinit");
		git(path, "submodule", "--quiet", "deinit", "--force", submodulePath);
		const state = readPinState(path);
		expect(state.gitlink).toBe(tagged);
		expect(state.head).toBeUndefined();
		expect(pinGuardFailures(state)).toStrictEqual([
			"vendor/mldsa-native isn't initialized, so the guard can't read upstream's tags. Run `git submodule update --init`.",
		]);
	});
});
