import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { root } from "../../../scripts/check-step.ts";
import { coreStructureFailures } from "./core-structure.ts";

const file = "packages/ml-dsa/src/core.ts";
const source = readFileSync(join(root, file), "utf8");

/** The core's source with `before` replaced once by `after`. Fails if `before` isn't in the source. */
function changed(before: string, after: string): string {
	expect(source).toContain(before);
	return source.replace(before, after);
}

/** The line of the first occurrence of `text` in `changedSource`. */
function lineOf(changedSource: string, text: string): number {
	return changedSource.slice(0, changedSource.indexOf(text)).split("\n").length;
}

const stackEdge = "which can fail to start at the engine's stack limit.";

describe("the structural check of the core", () => {
	test("passes the core as committed", () => {
		expect(coreStructureFailures(file, source)).toStrictEqual([]);
	});

	const release = "\t\t\t\t\trelease(shakeState);\n";
	const healthyFills = "\t\t\t\t\tmemory.fill(0, heapBase);\n";
	const wholeFill = "\t\t\t\t\tmemory.fill(0);\n";
	const firstCatch = "\t\t} catch (error) {\n\t\t\tfailure = error;\n";
	const loopStore = "\t\t\t\t\t\twords[index] = 0;\n";

	test.each([
		[
			"a call in a catch block",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tfailure = String(error);\n",
			"String(error)",
			`the core's catch block holds a call outside the four designated calls, ${stackEdge}`,
		],
		[
			"a `new` in a catch block",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tfailure = new Error();\n",
			"new Error()",
			`the core's catch block holds a \`new\`, ${stackEdge}`,
		],
		[
			"a member read in the finally block",
			"\t\t\tif (!poisoned && shakeStarted) {",
			"\t\t\tif (!poisoned && memory.length) {",
			"memory.length",
			`the core's finally block holds a member read, which can run a getter, ${stackEdge}`,
		],
		[
			"an assignment to another binding",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tshakeStarted = false;\n",
			"shakeStarted = false",
			`the core's catch block holds an assignment to \`shakeStarted\`, ${stackEdge}`,
		],
		[
			"an object literal",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tfailure = { error };\n",
			"{ error }",
			`the core's catch block holds an ObjectExpression, ${stackEdge}`,
		],
		[
			"a throw in a catch block",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tthrow error;\n",
			"throw error",
			`the core's catch block holds a ThrowStatement, ${stackEdge}`,
		],
		[
			"a store into a member that isn't a const local",
			loopStore,
			"\t\t\t\t\t\theld.memory[index] = 0;\n",
			"for (let index",
			`the core's catch block holds a loop that does more than store 0 into a \`const\` local view, ${stackEdge}`,
		],
		[
			"an argument that isn't a local",
			healthyFills,
			"\t\t\t\t\tmemory.fill(0, held.heapBase);\n",
			"memory.fill(0, held.heapBase)",
			`the core's finally block holds a call whose arguments aren't all \`const\` locals or number literals, ${stackEdge}`,
		],
		[
			"an argument that is a module binding",
			healthyFills,
			"\t\t\t\t\tmemory.fill(0, recording);\n",
			"memory.fill(0, recording)",
			`the core's finally block holds a call whose arguments aren't all \`const\` locals or number literals, ${stackEdge}`,
		],
		[
			"a destructured catch binding",
			firstCatch,
			"\t\t} catch ({ stack }) {\n\t\t\tfailure = stack;\n",
			"{ stack }",
			`the core's catch block holds a destructured \`catch\` binding, which reads the error's properties, ${stackEdge}`,
		],
		[
			"an `if` statement in a catch block",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\tif (poisoned) {\n\t\t\t\tfailure = error;\n\t\t\t}\n",
			"if (poisoned) {",
			`the core's catch block holds an \`if\` statement, ${stackEdge}`,
		],
		[
			"a condition with another operator",
			"\t\t\tif (!poisoned && shakeStarted) {",
			"\t\t\tif (!poisoned && shakeStarted == true) {",
			"shakeStarted == true",
			`the core's finally block holds a BinaryExpression, ${stackEdge}`,
		],
		[
			"a loop outside the fallback",
			"\t\t\tif (!poisoned && shakeStarted) {",
			"\t\t\tfor (let index = 0; index < wordCount; index += 1) {\n\t\t\t\twords[index] = 0;\n\t\t\t}\n\t\t\tif (!poisoned && shakeStarted) {",
			"for (let index = 0; index < wordCount; index += 1) {\n\t\t\t\twords",
			`the core's finally block holds a loop outside the fallback, ${stackEdge}`,
		],
		[
			"a nested try statement",
			firstCatch,
			"\t\t} catch (error) {\n\t\t\ttry {\n\t\t\t\tfailure = error;\n\t\t\t} catch {}\n",
			"\t\t\ttry {\n\t\t\t\tfailure = error;",
			`the core's catch block holds a nested \`try\` statement, ${stackEdge}`,
		],
	])("fails on %s", (_, before, after, marker, message) => {
		const broken = changed(before, after);
		expect(coreStructureFailures(file, broken)).toStrictEqual([
			`${file}:${lineOf(broken, marker)}: ${message}`,
		]);
	});

	test("fails when the release's callee isn't a const local", () => {
		const broken = changed(
			"const release = held.functions.mldsa_shake256_release;",
			"let release = held.functions.mldsa_shake256_release;",
		);
		expect(coreStructureFailures(file, broken)).toStrictEqual([
			`${file}:${lineOf(broken, release.trim())}: the release calls \`release\`, which isn't a \`const\` local of runCore.`,
		]);
	});

	test("fails on a call that is neither the release nor a fill, which also leaves the release out", () => {
		const broken = changed(release, "\t\t\t\t\tmemory.set(words);\n");
		expect(coreStructureFailures(file, broken)).toStrictEqual([
			`${file}:${lineOf(broken, "memory.set(words)")}: the core's finally block holds a call that is neither the release nor a fill on a \`const\` local, ${stackEdge}`,
			`${file}:${lineOf(broken, "} finally {")}: the \`try\` statements of the \`finally\` block hold the calls [[],["fill","fill"],["fill"]] instead of [["release"],["fill","fill"],["fill"]].`,
		]);
	});

	test("fails on a fifth call, and on a call outside its designated try block", () => {
		const fifth = changed(release, `${release}\t\t\t\t\trelease(shakeState);\n`);
		const outside = changed(wholeFill, "").replace(
			"\t\t\tif (poisoned) {\n",
			`\t\t\tif (poisoned) {\n${wholeFill}`,
		);
		const finallyLine = (broken: string): number => lineOf(broken, "} finally {");
		expect(coreStructureFailures(file, fifth)).toStrictEqual([
			`${file}:${finallyLine(fifth)}: the \`try\` statements of the \`finally\` block hold the calls [["release","release"],["fill","fill"],["fill"]] instead of [["release"],["fill","fill"],["fill"]].`,
		]);
		expect(coreStructureFailures(file, outside)).toStrictEqual([
			`${file}:${lineOf(outside, wholeFill.trim())}: the core's finally block holds a call outside the four designated calls, ${stackEdge}`,
			`${file}:${finallyLine(outside)}: the \`try\` statements of the \`finally\` block hold the calls [["release"],["fill","fill"],[]] instead of [["release"],["fill","fill"],["fill"]].`,
		]);
	});

	test("fails unless the core holds exactly one finally block", () => {
		const broken = changed(
			"\tif (instance !== null) {\n",
			"\ttry {\n\t\tpoisoned = false;\n\t} finally {\n\t\tpoisoned = false;\n\t}\n\tif (instance !== null) {\n",
		);
		expect(coreStructureFailures(file, broken)).toStrictEqual([
			`${file}:${lineOf(broken, "export function runCore")}: runCore holds 2 \`finally\` blocks instead of one.`,
		]);
	});

	test("fails unless the source holds exactly one core function", () => {
		expect(
			coreStructureFailures(file, source.replace("function runCore", "function runOther")),
		).toStrictEqual([`${file}: the source holds 0 functions named runCore instead of one.`]);
		expect(coreStructureFailures(file, `${source}\nfunction runCore(): void {}\n`)).toStrictEqual([
			`${file}: the source holds 2 functions named runCore instead of one.`,
		]);
	});
});
