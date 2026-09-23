/**
 * Line-level change summaries for the file-mutating tools.
 *
 * Why this exists: the user has to be able to see *what the agent did to their
 * files* before they can be comfortable letting it touch real ones. A tool row
 * that says "write · report.md" and nothing else asks for trust it has not
 * earned.
 *
 * The two tools are not symmetric, and the asymmetry is worth stating rather
 * than papering over:
 *
 *   - `edit` already reports a unified diff in its result details (pi computes
 *     it), so the counts come straight from that — no extra work, and the
 *     numbers describe exactly the change that was applied.
 *   - `write` reports nothing at all, and the only way to know what it
 *     *removed* is to have the previous content. So the previous content is
 *     snapshotted before the call and diffed against what was written.
 *
 * The snapshot is why this is hooked into the agent loop rather than done in
 * the renderer: by the time a front-end sees the result, the old bytes are gone.
 *
 * Snapshots are bounded by `MAX_SNAPSHOT_BYTES`. Above that the summary reports
 * the written size and says the comparison was skipped, rather than reading a
 * huge file into memory to produce a number nobody asked for.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { diffLines } from "diff";

/** Largest previous file this will read to compute a delta. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface ChangeSummary {
	/** Path as the model wrote it, which is what the user recognises. */
	path: string;
	added: number;
	removed: number;
	/** True when the target did not exist before the call. */
	created: boolean;
	/**
	 * True when a real delta could not be computed — the file was too large, or
	 * unreadable. The counts then describe what was written, not what changed,
	 * and the interface should not present them as a delta.
	 */
	approximate: boolean;
}

/** Tools whose effect on a file is worth summarising. */
export const MUTATING_TOOLS = new Set(["write", "edit"]);

/** The path argument, when the call has one. */
function pathOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>).path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Resolve a model-supplied path the same way the tools do. */
export function resolveTarget(path: string, cwd: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Read the file a `write`/`edit` is about to change, or undefined.
 *
 * Called before the tool runs. A missing file is not an error — it means the
 * call is creating it, which the summary reports as `created`.
 */
export function snapshotBefore(args: unknown, cwd: string): string | undefined {
	const path = pathOf(args);
	if (path === undefined) return undefined;
	const abs = resolveTarget(path, cwd);
	try {
		if (statSync(abs).size > MAX_SNAPSHOT_BYTES) return undefined;
		return readFileSync(abs, "utf-8");
	} catch {
		return undefined;
	}
}

/** Whether the target existed, used to tell "created" from "overwritten". */
export function targetExists(args: unknown, cwd: string): boolean {
	const path = pathOf(args);
	if (path === undefined) return false;
	try {
		return statSync(resolveTarget(path, cwd)).isFile();
	} catch {
		return false;
	}
}

/**
 * How many lines a block of text occupies.
 *
 * A trailing newline does not start a new line, so `"x\n"` is one line and not
 * two. Splitting on `\n` alone reports two, which inflates every count in this
 * file by one — the kind of error that looks plausible enough to survive a
 * glance at the output.
 */
function lineCount(text: string): number {
	if (text.length === 0) return 0;
	const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
	return trimmed.split("\n").length;
}

/** Count added/removed lines between two strings. */
function countLines(before: string, after: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const part of diffLines(before, after)) {
		const lines = lineCount(part.value);
		if (part.added) added += lines;
		else if (part.removed) removed += lines;
	}
	return { added, removed };
}

/**
 * Summarise a finished call.
 *
 * `previous` is the snapshot taken before execution, and is what makes the
 * `removed` count meaningful for `write`. For `edit` the diff pi already
 * computed is preferred, because it reflects what was actually applied —
 * including fuzzy matches — rather than what the model asked for.
 */
export function summarizeChange(
	toolName: string,
	args: unknown,
	previous: string | undefined,
	cwd: string,
	resultDetails?: unknown,
): ChangeSummary | undefined {
	if (!MUTATING_TOOLS.has(toolName)) return undefined;
	const path = pathOf(args);
	if (path === undefined) return undefined;

	const details = resultDetails as { diff?: unknown } | undefined;
	if (toolName === "edit" && typeof details?.diff === "string") {
		const lines = details.diff.split("\n");
		const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
		return { path, added, removed, created: previous === undefined, approximate: false };
	}

	if (toolName === "write") {
		const content = (args as Record<string, unknown>).content;
		if (typeof content !== "string") return undefined;
		const written = lineCount(content);
		if (previous === undefined) {
			// Either a new file, or one too large to have been snapshotted. The
			// existence check separates the two.
			const existed = targetExists(args, cwd);
			return existed
				? { path, added: written, removed: 0, created: false, approximate: true }
				: { path, added: written, removed: 0, created: true, approximate: false };
		}
		const { added, removed } = countLines(previous, content);
		return { path, added, removed, created: false, approximate: false };
	}

	return undefined;
}
