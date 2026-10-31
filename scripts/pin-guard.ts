import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { CommandFailed } from "./check-step.ts";

/** The submodule that pins upstream, relative to the repo root. */
export const submodulePath = "vendor/mldsa-native";

const packageJsonFile = "packages/ml-dsa/package.json";
const readmeFile = "packages/ml-dsa/README.md";

/**
 * The command that updates the submodule's tags to upstream's. A plain
 * `git fetch --tags` keeps a tag that upstream deleted and refuses to move one
 * that upstream moved, so the guard would pass on stale tags.
 */
const fetchTagsCommand = `git -C ${submodulePath} fetch --force --prune --prune-tags origin`;

/** A stable upstream release tag. Release candidates and other suffixed tags don't match. */
const stableTag = /^v\d+\.\d+\.\d+$/;

/** The independent-build statement in the package README, with the tag and the commit it names. */
const independentBuildStatement =
	/This package is an independent build of mldsa-native, not a NIST or pq-code-package release\.\s+It builds from mldsa-native ([^\s,]+), commit `([^`]+)`\./g;

const MldsaNative = z.looseObject({
	tag: z.string(),
	commit: z.string().regex(/^[0-9a-f]{40}$/),
});

const PackageJson = z.looseObject({ mldsaNative: z.unknown() });

/** What the pin guard reads from the repo. */
export interface PinState {
	/** The commit that the superproject's index records for the submodule, if it records one. */
	readonly gitlink: string | undefined;
	/** The submodule's checked-out commit, or `undefined` when the submodule isn't initialized. */
	readonly head: string | undefined;
	/** The submodule's `git status --porcelain` lines, untracked and ignored files included. */
	readonly changes: readonly string[];
	/** The commit of each stable tag that the submodule has fetched. */
	readonly stableTags: ReadonlyMap<string, string>;
	/** The `mldsaNative` field of the package's `package.json`, unparsed. */
	readonly mldsaNative: unknown;
	/** The package README's text, or `undefined` when the file is missing. */
	readonly readme: string | undefined;
}

/** The release that the `mldsaNative` field or the README's statement says the pin is. */
interface PinClaim {
	/** Who makes the claim, as the failure messages name it. */
	readonly claimant: string;
	readonly tag: string;
	readonly commit: string;
}

/** Collects the pin claims of the field and the README, with a failure for each claim that is missing or malformed. */
function pinClaims(state: PinState): { claims: PinClaim[]; failures: string[] } {
	const claims: PinClaim[] = [];
	const failures: string[] = [];

	const field = MldsaNative.safeParse(state.mldsaNative);
	if (field.success) {
		claims.push({ claimant: `The mldsaNative field in ${packageJsonFile}`, ...field.data });
	} else {
		failures.push(
			`${packageJsonFile} must hold "mldsaNative": { "tag": "vX.Y.Z", "commit": "<40 hex digits>" }.`,
		);
	}

	const statements = [...(state.readme ?? "").matchAll(independentBuildStatement)];
	if (statements.length === 0) {
		failures.push(
			`${readmeFile} has no independent-build statement that names the pin: "This package is an independent build of mldsa-native, not a NIST or pq-code-package release. It builds from mldsa-native vX.Y.Z, commit \`<commit>\`."`,
		);
	}
	for (const [, tag = "", commit = ""] of statements) {
		claims.push({ claimant: `The independent-build statement in ${readmeFile}`, tag, commit });
	}
	return { claims, failures };
}

/**
 * Returns one message per broken pin rule, or none when the pin holds. Each
 * message says what failed and why. The rules: the submodule is initialized,
 * sits at the gitlink, and has no changes or untracked files, ignored ones
 * included. The gitlink is the commit of a stable tag `vX.Y.Z`. The
 * `mldsaNative` field and the README's independent-build statement both name
 * that tag and that commit, and a tag that upstream deleted counts as moved.
 */
export function pinGuardFailures(state: PinState): readonly string[] {
	const { gitlink, head } = state;
	if (gitlink === undefined) {
		return [`The repo records no gitlink for ${submodulePath}, so nothing pins upstream.`];
	}
	if (head === undefined) {
		return [
			`${submodulePath} isn't initialized, so the guard can't read upstream's tags. Run \`git submodule update --init\`.`,
		];
	}

	const failures: string[] = [];
	if (head !== gitlink) {
		failures.push(
			`${submodulePath} is checked out at ${head}, but the gitlink records ${gitlink}. Run \`git submodule update\`, or commit the gitlink you mean to pin.`,
		);
	}
	if (state.changes.length > 0) {
		failures.push(
			`${submodulePath} has changes or untracked files, ignored ones included, and every file in it must equal the pin:\n${state.changes.map((line) => `  ${line}`).join("\n")}`,
		);
	}

	if (![...state.stableTags.values()].includes(gitlink)) {
		failures.push(
			`The gitlink ${gitlink} isn't the commit of any stable tag of the form vX.Y.Z among the submodule's fetched tags. Pin a stable upstream release, or update the tags with \`${fetchTagsCommand}\`.`,
		);
	}

	const { claims, failures: claimFailures } = pinClaims(state);
	failures.push(...claimFailures);
	for (const claim of claims) {
		const tagCommit = state.stableTags.get(claim.tag);
		if (!stableTag.test(claim.tag)) {
			failures.push(
				`${claim.claimant} names ${claim.tag}, which isn't a stable tag of the form vX.Y.Z.`,
			);
		} else if (tagCommit === undefined) {
			failures.push(
				`${claim.claimant} names ${claim.tag}, which isn't among the submodule's fetched tags. Upstream deleted the tag, which counts as moved, or the tags weren't fetched. Update them with \`${fetchTagsCommand}\`.`,
			);
		} else if (tagCommit !== claim.commit) {
			failures.push(
				`${claim.claimant} names ${claim.tag} at ${claim.commit}, but the tag points at ${tagCommit}. Upstream moved the tag, or the commit it names is wrong. Update the tags with \`${fetchTagsCommand}\` to see upstream's.`,
			);
		}
		if (claim.commit !== gitlink) {
			failures.push(
				`${claim.claimant} names commit ${claim.commit}, but the gitlink records ${gitlink}. Update the field and the README when the pin moves.`,
			);
		}
	}
	// Two tags can point at one commit, so each claim can pass alone while the
	// claims name different releases. A claim of another commit already failed
	// above, so this rule waits until every claim names the gitlink.
	const tags = new Set(claims.map((claim) => claim.tag));
	if (tags.size > 1 && claims.every((claim) => claim.commit === gitlink)) {
		failures.push(
			`The field and every independent-build statement must name the same tag. ${claims.map((claim) => `${claim.claimant} names ${claim.tag}.`).join(" ")}`,
		);
	}
	return failures;
}

function git(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new CommandFailed(`\`git ${args.join(" ")}\` failed in ${cwd}: ${result.stderr.trim()}`);
	}
	// Only the end is trimmed, because a porcelain status line starts with a space.
	return result.stdout.trimEnd();
}

function lines(text: string): string[] {
	return text === "" ? [] : text.split("\n");
}

/**
 * Returns the `mldsaNative` field of a `package.json` text, or `undefined`
 * when the text isn't valid JSON, isn't an object, or has no such field.
 */
function mldsaNativeField(text: string): unknown {
	try {
		const parsed = PackageJson.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data.mldsaNative : undefined;
	} catch {
		return undefined;
	}
}

function readOptional(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Reads the pin guard's inputs from the git repo at `root`. */
export function readPinState(root: string): PinState {
	const entry = /^160000 ([0-9a-f]{40}) 0\t/.exec(
		git(root, ["ls-files", "--stage", "--", submodulePath]),
	);
	const submodule = join(root, submodulePath);

	// An uninitialized submodule leaves an empty folder, so git inside it finds
	// the superproject instead.
	const initialized =
		existsSync(submodule) &&
		git(submodule, ["rev-parse", "--show-prefix"]) === "" &&
		git(submodule, ["rev-parse", "--is-inside-work-tree"]) === "true";

	const changes: string[] = [];
	const stableTags = new Map<string, string>();
	if (initialized) {
		changes.push(
			...lines(git(submodule, ["status", "--porcelain", "--untracked-files=all", "--ignored"])),
		);
		for (const tag of lines(git(submodule, ["tag", "--list"]))) {
			if (stableTag.test(tag)) {
				// The object of an annotated tag isn't a commit, so peel each tag to its commit.
				stableTags.set(tag, git(submodule, ["rev-parse", `refs/tags/${tag}^{commit}`]));
			}
		}
	}

	const packageJson = readOptional(join(root, packageJsonFile));
	return {
		gitlink: entry?.[1],
		head: initialized ? git(submodule, ["rev-parse", "HEAD"]) : undefined,
		changes,
		stableTags,
		mldsaNative: packageJson === undefined ? undefined : mldsaNativeField(packageJson),
		readme: readOptional(join(root, readmeFile)),
	};
}
