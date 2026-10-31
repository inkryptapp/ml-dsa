import { expect, test } from "vite-plus/test";

import { runTool, toolTimeout } from "./dev-tools.js";

// `tsgolint` skips declaration diagnostics, so `vp check` passes an export
// without a type annotation. The typecheck script runs `tsc` to catch it. The
// fixture's tsconfig extends the package's, so the test fails if the package's
// tsconfig stops turning on `isolatedDeclarations`.
test("tsc rejects an export that isolatedDeclarations can't type", { timeout: toolTimeout }, () => {
	const result = runTool("tsc", ["-p", "packages/ml-dsa/test/fixtures/isolated-declarations"]);
	expect(result.status).not.toBe(0);
	expect(result.stdout).toContain("error TS9013");
});
