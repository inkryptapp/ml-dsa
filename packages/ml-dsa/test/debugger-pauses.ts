// Pauses the core through V8's inspector, so an exit-matrix row can run a
// public call at a breakable point of the core's cleanup, as a call made from
// a debugger console would. Only Node has `node:inspector`, so outside Node
// the core has no pause points and the matrix lists no such rows.
//
// The inspector's same-thread session answers each `post` and delivers each
// event before `post` returns, so these functions are synchronous.

import type { Debugger, Session } from "node:inspector";

/** A breakable point in the script of `src/core.ts` that the test runner loaded. */
export interface PausePoint {
	readonly lineNumber: number;
	readonly columnNumber: number;
	/** The point's position among the cleanup's points, counted from 1. */
	readonly position: number;
	/** The script's text from the point to the end of its line. */
	readonly statement: string;
}

interface CoreScript {
	readonly session: Session;
	readonly scriptId: string;
	/** Every breakable point from the core's `finally` block to its clear of `checkedOut`. */
	readonly cleanup: readonly PausePoint[];
}

let core: CoreScript | null | undefined = undefined;

/** The result that `post` gives its callback, which the session calls before `post` returns. */
function answer<Result>(
	post: (callback: (error: Error | null, result: Result) => void) => void,
): Result {
	let answered: { readonly result: Result } | null = null;
	post((error, result) => {
		if (error !== null) {
			throw error;
		}
		answered = { result };
	});
	if (answered === null) {
		throw new Error("The inspector didn't answer before `post` returned.");
	}
	const { result } = answered;
	return result;
}

/** The index of the first line at or after `from` that holds `text`. */
function lineOf(lines: readonly string[], text: string, from: number): number {
	const index = lines.findIndex((line, at) => at >= from && line.includes(text));
	if (index === -1) {
		throw new Error(`The core's script holds no "${text}".`);
	}
	return index;
}

/** The core's script and its cleanup's pause points, or `null` outside Node. */
function coreScript(): CoreScript | null {
	if (core !== undefined) {
		return core;
	}
	const inspector =
		typeof process === "undefined" ? undefined : process.getBuiltinModule("node:inspector");
	if (inspector === undefined) {
		core = null;
		return core;
	}
	const session = new inspector.Session();
	session.connect();
	const scriptIds: string[] = [];
	session.on("Debugger.scriptParsed", ({ params }) => {
		if (params.url.includes("/src/core.ts")) {
			scriptIds.push(params.scriptId);
		}
	});
	// Enabling the debugger reports every script that the runtime has parsed.
	answer((callback) => {
		session.post("Debugger.enable", callback);
	});
	session.removeAllListeners("Debugger.scriptParsed");
	for (const scriptId of scriptIds) {
		const { scriptSource } = answer<Debugger.GetScriptSourceReturnType>((callback) => {
			session.post("Debugger.getScriptSource", { scriptId }, callback);
		});
		if (!scriptSource.includes("function runCore")) {
			continue;
		}
		const lines = scriptSource.split("\n");
		const start = lineOf(lines, "} finally {", lineOf(lines, "function runCore", 0));
		const clear = lineOf(lines, "checkedOut = null;", start);
		const { locations } = answer<Debugger.GetPossibleBreakpointsReturnType>((callback) => {
			session.post(
				"Debugger.getPossibleBreakpoints",
				{
					start: { scriptId, lineNumber: start, columnNumber: 0 },
					end: { scriptId, lineNumber: clear + 1, columnNumber: 0 },
				},
				callback,
			);
		});
		core = {
			session,
			scriptId,
			cleanup: locations.map(({ lineNumber, columnNumber = 0 }, index) => ({
				lineNumber,
				columnNumber,
				position: index + 1,
				statement: (lines[lineNumber] ?? "").slice(columnNumber).trim(),
			})),
		};
		return core;
	}
	throw new Error("The inspector reports no script of src/core.ts that holds runCore.");
}

/**
 * Runs `action` with a breakpoint at each of `points`, and calls `paused` with
 * the point of each pause before the call resumes.
 */
function withBreakpoints<Value>(
	script: CoreScript,
	points: readonly PausePoint[],
	paused: (point: PausePoint) => void,
	action: () => Value,
): Value {
	const { session, scriptId } = script;
	const ids = new Map(
		points.map((point) => {
			const { lineNumber, columnNumber } = point;
			const { breakpointId } = answer<Debugger.SetBreakpointReturnType>((callback) => {
				session.post(
					"Debugger.setBreakpoint",
					{ location: { scriptId, lineNumber, columnNumber } },
					callback,
				);
			});
			return [breakpointId, point];
		}),
	);
	const onPaused = ({ params }: { params: Debugger.PausedEventDataType }): void => {
		try {
			for (const id of params.hitBreakpoints ?? []) {
				const point = ids.get(id);
				if (point !== undefined) {
					paused(point);
				}
			}
		} finally {
			session.post("Debugger.resume");
		}
	};
	session.on("Debugger.paused", onPaused);
	try {
		return action();
	} finally {
		session.off("Debugger.paused", onPaused);
		for (const breakpointId of ids.keys()) {
			session.post("Debugger.removeBreakpoint", { breakpointId });
		}
	}
}

/** The pause points of the core's cleanup that `action` reaches, in order, or `[]` outside Node. */
export function cleanupPausesOf(action: () => unknown): readonly PausePoint[] {
	const script = coreScript();
	if (script === null) {
		return [];
	}
	const reached: PausePoint[] = [];
	withBreakpoints(script, script.cleanup, (point) => reached.push(point), action);
	return reached;
}

/**
 * Runs `action` with a breakpoint at `point`. At the first pause there, it
 * calls `atPause` before the call resumes. Returns what `action` returned and
 * whether the call paused at `point`.
 */
export function pausedAt<Value>(
	point: PausePoint,
	atPause: () => void,
	action: () => Value,
): { readonly value: Value; readonly paused: boolean } {
	const script = coreScript();
	if (script === null) {
		throw new Error("Only Node can pause the core.");
	}
	let paused = false;
	const value = withBreakpoints(
		script,
		[point],
		() => {
			if (!paused) {
				paused = true;
				atPause();
			}
		},
		action,
	);
	return { value, paused };
}
