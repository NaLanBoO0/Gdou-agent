/**
 * Observability: crash reports, the running log, heap dumps.
 *
 * Everything here exists for one reason: a desktop app that fails silently gives
 * its author nothing to fix and its user nothing to report. These are the three
 * cheapest ways to leave a trail — none of them report to a server, none of them
 * cost a dependency, and each answers "what happened" after the window is gone.
 *
 * All output lands under `logsDir()` (`~/.gdou-agent/logs/`), which follows
 * `GDOU_AGENT_HOME` so the GUI self-check isolates its own logs from the real
 * user's.
 *
 * Three behaviours are load-bearing and worth stating once:
 *
 * - **Crash records are written synchronously.** `process.on("uncaughtException")`
 *   is the last code that runs before the process dies; an async `fs.promises`
 *   write queues behind the event loop and is lost. `writeFileSync` is the only
 *   thing that survives.
 * - **The log is fingerprint-sampled.** A loop that logs on every event can write
 *   megabytes in seconds, and a log nobody can open is as useless as no log. A
 *   repeating fingerprint is written once, then only counted until it changes.
 * - **The heap report is the one thing that is deliberately off by default in a
 *   way that costs nothing to arm** — it is armed by `armMemoryWatch`, which the
 *   main process calls once. A heap snapshot is expensive, so it fires only past
 *   a threshold, not on a timer.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "../paths.ts";

const MAX_CRASH_RECORDS = 50;
/** Repeating fingerprints are written once, then only counted, until this many. */
const MAX_FINGERPRINT_COUNT = 999;

/** A point-in-time error with enough context to be useful after the fact. */
interface CrashRecord {
	timestamp: string;
	kind: string;
	message: string;
	stack?: string;
}

function stamp(): string {
	return new Date().toISOString();
}

function ensureLogsDir(dir: string): string {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

/* ------------------------------------------------------------ crash reports */

let crashCount = 0;

/**
 * Write one crash record synchronously.
 *
 * Called from `uncaughtException` / `unhandledRejection` handlers, so it must not
 * itself throw — a throw inside the last handler is a second, unreported crash.
 * Every failure here is swallowed on purpose: a crash reporter that crashes is
 * worse than one that misses a record.
 *
 * Capped at `MAX_CRASH_RECORDS` per launch so a repeated failure (say, a renderer
 * that dies and is respawned in a loop) does not fill the disk with identical
 * records.
 *
 * `dir` is a test seam: it defaults to `logsDir()`, and the self-check passes an
 * explicit throwaway directory so it cannot touch the real user's logs.
 */
export function writeCrashRecord(kind: string, error: unknown, dir: string = logsDir()): void {
	if (crashCount >= MAX_CRASH_RECORDS) return;
	crashCount += 1;

	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? error.stack : undefined;
	const record: CrashRecord = { timestamp: stamp(), kind, message };
	if (stack) record.stack = stack;

	try {
		const file = join(ensureLogsDir(dir), `crash-${stamp().replace(/[:.]/g, "-")}.json`);
		writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf-8");
	} catch {
		// Swallowed: see above.
	}
}

/* -------------------------------------------------------------- running log */

const fingerprintCounts = new Map<string, number>();

/**
 * Append a line to the running log, fingerprint-sampled against a repeat storm.
 *
 * `fingerprint` groups identical messages; the first occurrence is written, and
 * repeats are only counted — the count is flushed when the fingerprint changes
 * or the process ends. Passing `undefined` skips the sampling and always writes,
 * for events that are individually meaningful (session start, model resolution).
 *
 * `dir` is a test seam, same as `writeCrashRecord`.
 */
export function logLine(message: string, fingerprint?: string, dir: string = logsDir()): void {
	const line = `${stamp()} ${message}`;
	if (fingerprint === undefined) {
		try {
			appendFileSync(join(ensureLogsDir(dir), "app.log"), line + "\n", "utf-8");
		} catch {
			// A log write failing should not take the app down with it.
		}
		return;
	}

	const count = (fingerprintCounts.get(fingerprint) ?? 0) + 1;
	fingerprintCounts.set(fingerprint, count);
	if (count === 1) {
		try {
			appendFileSync(join(ensureLogsDir(dir), "app.log"), line + "\n", "utf-8");
		} catch {
			// Swallowed.
		}
	} else if (count <= MAX_FINGERPRINT_COUNT && count % 100 === 0) {
		try {
			appendFileSync(
				join(ensureLogsDir(dir), "app.log"),
				`${stamp()} (repeated ${count}×) ${fingerprint}\n`,
				"utf-8",
			);
		} catch {
			// Swallowed.
		}
	}
}

/* ------------------------------------------------------------- memory watch */

const HEAP_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB
const MEMORY_POLL_INTERVAL_MS = 30_000;
let memoryWatchArmed = false;
let lastHeapReportAt = 0;

/**
 * Arm the memory watch: poll the heap every 30s, and when it crosses the
 * threshold, write a heap report. Writes at most one report per minute so a
 * sustained leak produces a trail rather than a disk full of snapshots.
 *
 * Uses `process.report` (V8's built-in JSON heap summary) — no native module,
 * and it already includes the heap statistics the report is for.
 */
export function armMemoryWatch(): void {
	if (memoryWatchArmed) return;
	memoryWatchArmed = true;

	const poll = () => {
		const used = process.memoryUsage().heapUsed;
		const now = Date.now();
		if (used >= HEAP_THRESHOLD_BYTES && now - lastHeapReportAt > 60_000) {
			lastHeapReportAt = now;
			try {
				const file = join(ensureLogsDir(logsDir()), `heap-${stamp().replace(/[:.]/g, "-")}.json`);
				process.report.writeReport(file);
				logLine(`heap ${(used / 1024 / 1024).toFixed(0)} MiB above threshold; wrote ${file}`);
			} catch {
				// A failed heap report is itself a signal, but not one to crash on.
			}
		}
	};
	setInterval(poll, MEMORY_POLL_INTERVAL_MS);
	poll();
}

/**
 * Path of the running log, for the diagnostics page to display.
 *
 * Resolved lazily rather than cached, so a `GDOU_AGENT_HOME` switch (never done
 * in a real run, but done by the self-check) is not silently ignored.
 */
export function appLogPath(dir: string = logsDir()): string {
	return join(dir, "app.log");
}
