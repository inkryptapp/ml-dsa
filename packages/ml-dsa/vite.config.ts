/**
 * The pack configs of the npm package, which `vp pack` builds into `dist/`.
 * The root `vite.config.ts` holds the lint, format, and test settings.
 */
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "vite-plus";
import type { PackUserConfig } from "vite-plus/pack";

import { wasmBase64, wasmModuleFile } from "./wasm-imports.ts";

const packageRoot = import.meta.dirname;
const repoRoot = join(packageRoot, "../..");

// npm packs nothing from outside the package folder, and npm and pnpm both
// drop symlinks, so the licenses are copied in as real files.
async function copyLicenses(): Promise<void> {
	await copyFile(join(repoRoot, "LICENSE"), join(packageRoot, "LICENSE"));
	await copyFile(
		join(repoRoot, "vendor/mldsa-native/LICENSE"),
		join(packageRoot, "LICENSE-mldsa-native"),
	);
}

// tsdown reads `engines.node` as its default target, so each config sets the
// level of the `lib` in `tsconfig.base.json`. The structural check and the
// path scan read the shipped files, so they stay unminified.
const shared = {
	platform: "neutral",
	target: "es2024",
	minify: false,
} as const;

/**
 * The two pack configs, one per entry. A build of both entries would move
 * their shared code into a chunk that both import. Apart, each entry builds
 * into one file that holds the whole core.
 */
export const packConfigs: readonly PackUserConfig[] = [
	{
		...shared,
		entry: { index: "src/index.ts" },
		dts: true,
		plugins: [wasmBase64()],
		hooks: { "build:prepare": copyLicenses },
	},
	{
		...shared,
		entry: { workerd: "src/workerd.ts" },
		dts: false,
		plugins: [wasmModuleFile()],
	},
];

export default defineConfig({ pack: [...packConfigs] });
