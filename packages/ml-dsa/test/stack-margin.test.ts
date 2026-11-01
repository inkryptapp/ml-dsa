import { describe, expect, test } from "vite-plus/test";

import type { FunctionName } from "../src/module-exports.js";
import { layout, setExportHook } from "../src/testing.js";
import { byteSource, freshMemoryMismatch, parameterSetCases, seedFrom } from "./helpers.js";

/**
 * The bytes that fill the wasm stack before each export call. A write of a
 * byte that equals the pattern doesn't show in the measurement. A byte equals
 * at most one of the three, so the deepest of the three runs finds it.
 */
const patterns = [0x00, 0xa5, 0x5a] as const;

/** The largest share of the wasm stack that an operation may reach. */
const limit = 0.75;

const stackBytes = layout.stack.end - layout.stack.start;

/**
 * The peak of each operation with the committed module, in bytes. A pin bump
 * or a build change that moves a peak fails until someone reviews the new
 * peak and updates it here.
 */
const pinnedPeaks: Readonly<Record<string, number>> = {
	"mlDsa44.keygen": 31_393,
	"mlDsa44.sign": 48_833,
	"mlDsa44.verify": 29_185,
	"mlDsa65.keygen": 48_801,
	"mlDsa65.sign": 73_441,
	"mlDsa65.verify": 44_609,
	"mlDsa87.keygen": 79_521,
	"mlDsa87.sign": 112_353,
	"mlDsa87.verify": 73_537,
};

/**
 * Returns one message per rule of the stack margin that an operation's peak
 * breaks. A peak of 0 means that the measurement found no write, so the
 * measurement itself is broken.
 */
function marginFailures(name: string, peak: number, pinned: number | undefined): readonly string[] {
	const failures: string[] = [];
	if (peak === 0) {
		failures.push(`${name} reads 0 bytes, so the measurement found no write to the wasm stack.`);
	}
	if (peak > limit * stackBytes) {
		failures.push(
			`${name} reaches ${String(peak)} bytes, past ${String(limit * 100)}% of the ${String(stackBytes)}-byte wasm stack.`,
		);
	}
	if (peak !== pinned) {
		failures.push(
			`${name} reaches ${String(peak)} bytes, but its pinned peak is ${pinned === undefined ? "missing" : String(pinned)}. If the change is intended, review it, then update pinnedPeaks.`,
		);
	}
	return failures;
}

/** How deep an operation's export calls reached into the wasm stack. */
interface Peak {
	/** The bytes below `__stack_high` that the deepest call changed, or 0. */
	readonly bytes: number;
	/** The export that reached the peak, or `null` if no call changed the wasm stack. */
	readonly exportName: FunctionName | null;
}

/**
 * The bytes below `__stack_high` down to the lowest byte of the wasm stack
 * that no longer holds `pattern`, or 0 if every byte still holds it. The wasm
 * stack grows down from `__stack_high`.
 */
function depth(memory: Uint8Array, pattern: number): number {
	for (let offset = layout.stack.start; offset < layout.stack.end; offset += 1) {
		if (memory[offset] !== pattern) {
			return layout.stack.end - offset;
		}
	}
	return 0;
}

/**
 * Runs `operation` with the wasm stack filled with `pattern` before each
 * export call, and returns its result with the deepest peak of its calls.
 */
function measure<Result>(
	operation: () => Result,
	pattern: number,
): { readonly result: Result; readonly peak: Peak } {
	let peak: Peak = { bytes: 0, exportName: null };
	setExportHook((call) => {
		call.memory.fill(pattern, layout.stack.start, layout.stack.end);
		const result = call.proceed();
		const bytes = depth(call.memory, pattern);
		if (bytes > peak.bytes) {
			peak = { bytes, exportName: call.name };
		}
		return result;
	});
	try {
		return { result: operation(), peak };
	} finally {
		setExportHook(null);
	}
}

const bytes = byteSource(0x5ac4);
const message = bytes(100);
const context = bytes(8);
const randomness = bytes(32);

/** One operation with fixed inputs, and the result it must give. */
interface Operation {
	readonly name: string;
	readonly run: () => unknown;
	readonly expected: unknown;
}

/** Every operation of every parameter set. */
const operations: readonly Operation[] = parameterSetCases.flatMap(
	({ objectName, object }, index) => {
		const seed = seedFrom(index);
		const { publicKey } = object.keygen(seed);
		const signature = object.sign({ seed, message, context, randomness });
		return [
			{
				name: `${objectName}.keygen`,
				run: () => object.keygen(seed).publicKey,
				expected: publicKey,
			},
			{
				name: `${objectName}.sign`,
				run: () => object.sign({ seed, message, context, randomness }),
				expected: signature,
			},
			{
				name: `${objectName}.verify`,
				run: () => object.verify({ publicKey, message, context, signature }),
				expected: true,
			},
		];
	},
);

test.each(operations)(
	`$name reaches its pinned peak, more than 0 bytes and at most ${String(limit * 100)}% of the wasm stack`,
	({ name, run, expected }) => {
		const measured = patterns.map((pattern) => measure(run, pattern));
		for (const { result } of measured) {
			expect(result).toStrictEqual(expected);
		}
		const peak = measured
			.map((measurement) => measurement.peak)
			.reduce((deepest, next) => (next.bytes > deepest.bytes ? next : deepest));
		const share = (peak.bytes / stackBytes) * 100;
		console.info(
			`${name.padEnd(15)} ${String(peak.bytes).padStart(7)} of ${String(stackBytes)} bytes (${share.toFixed(1)}%) in ${peak.exportName ?? "no export"}`,
		);
		expect(marginFailures(name, peak.bytes, pinnedPeaks[name])).toStrictEqual([]);
		expect(freshMemoryMismatch()).toBeNull();
	},
);

test("pins a peak for every operation and no other", () => {
	expect(Object.keys(pinnedPeaks).toSorted()).toStrictEqual(
		operations.map(({ name }) => name).toSorted(),
	);
});

describe("the margin rules", () => {
	test("fail on a peak of 0, past 75% of the wasm stack, or away from its pin", () => {
		expect(marginFailures("x", 0, 0)).toStrictEqual([
			"x reads 0 bytes, so the measurement found no write to the wasm stack.",
		]);
		expect(marginFailures("x", 147_457, 147_457)).toStrictEqual([
			"x reaches 147457 bytes, past 75% of the 196608-byte wasm stack.",
		]);
		expect(marginFailures("x", 100, 99)).toStrictEqual([
			"x reaches 100 bytes, but its pinned peak is 99. If the change is intended, review it, then update pinnedPeaks.",
		]);
		expect(marginFailures("x", 100, undefined)).toStrictEqual([
			"x reaches 100 bytes, but its pinned peak is missing. If the change is intended, review it, then update pinnedPeaks.",
		]);
	});

	test("pass a pinned peak of exactly 75% of the wasm stack", () => {
		expect(marginFailures("x", 147_456, 147_456)).toStrictEqual([]);
	});
});

describe("depth", () => {
	test("finds the lowest changed byte of the wasm stack, and misses a write of the pattern itself", () => {
		const memory = new Uint8Array(layout.memoryBytes).fill(
			0x5a,
			layout.stack.start,
			layout.stack.end,
		);
		expect(depth(memory, 0x5a)).toBe(0);
		memory[layout.stack.end - 100] = 0x00;
		expect(depth(memory, 0x5a)).toBe(100);
		memory[layout.stack.end - 3000] = 0x5a;
		expect(depth(memory, 0x5a)).toBe(100);
		memory[layout.stack.start] = 0x01;
		expect(depth(memory, 0x5a)).toBe(stackBytes);
	});
});
