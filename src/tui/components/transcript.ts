/**
 * Transcript.
 *
 * The ordered list of everything rendered above the input line. Two
 * responsibilities beyond holding children:
 *
 * 1. Bounding. `TuiMainScreen` keeps the full array of previously rendered
 *    lines in order to diff the next frame against it, so an unbounded
 *    transcript makes every frame progressively more expensive - a session left
 *    open for hours would degrade without bound. Entries are dropped once the
 *    cap is reached, and a single dim line records that it happened, so the UI
 *    never silently loses context.
 *
 * 2. Tool bookkeeping. The keybindings act on tool calls as a group ("expand
 *    the last one", "expand all"), which is the transcript's render order, not
 *    something the caller can reconstruct without tracking it separately.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.ts";
import type { AssistantMessageView, UserMessageView } from "./messages.ts";
import type { NoticeView, StaticView } from "./notice.ts";
import type { ToolCallView } from "./tool-call.ts";

export type TranscriptEntry =
	| { kind: "user"; view: UserMessageView }
	| { kind: "assistant"; view: AssistantMessageView }
	| { kind: "tool"; view: ToolCallView }
	| { kind: "notice"; view: NoticeView }
	| { kind: "static"; view: StaticView };

/** Entries retained before the oldest are dropped. */
const MAX_ENTRIES = 200;

/** Blank line placed between entries. */
const GAP = "";

export class Transcript implements Component {
	private readonly theme: TuiTheme;
	private entries: TranscriptEntry[] = [];
	private elided = 0;

	constructor(theme: TuiTheme) {
		this.theme = theme;
	}

	push(entry: TranscriptEntry): void {
		this.entries.push(entry);
		this.enforceCap();
	}

	/** The most recent assistant view, or undefined when there is none. */
	get lastAssistant(): AssistantMessageView | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry?.kind === "assistant") return entry.view;
		}
		return undefined;
	}

	/** The most recent tool call, or undefined when there is none. */
	get lastTool(): ToolCallView | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry?.kind === "tool") return entry.view;
		}
		return undefined;
	}

	get toolCount(): number {
		let count = 0;
		for (const entry of this.entries) if (entry.kind === "tool") count++;
		return count;
	}

	/** How many tool calls are currently expanded. */
	get expandedToolCount(): number {
		let count = 0;
		for (const entry of this.entries) {
			if (entry.kind === "tool" && entry.view.isExpanded) count++;
		}
		return count;
	}

	/** Expand or collapse every tool call in one step. */
	setAllToolsExpanded(expanded: boolean): void {
		for (const entry of this.entries) {
			if (entry.kind === "tool") entry.view.setExpanded(expanded);
		}
	}

	clear(): void {
		for (const entry of this.entries) disposeEntry(entry);
		this.entries = [];
		this.elided = 0;
	}

	/** Stop every child timer. The transcript is unusable afterwards. */
	dispose(): void {
		this.clear();
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		const out: string[] = [];
		if (this.elided > 0) {
			out.push(this.theme.faint(`… ${this.elided} earlier entries elided`));
		}

		for (const entry of this.entries) {
			const lines = entry.view.render(width);
			if (lines.length === 0) continue;
			if (out.length > 0) out.push(GAP);
			for (const line of lines) out.push(line);
		}

		return out;
	}

	invalidate(): void {
		for (const entry of this.entries) entry.view.invalidate();
	}

	private enforceCap(): void {
		while (this.entries.length > MAX_ENTRIES) {
			const dropped = this.entries.shift();
			if (!dropped) break;
			disposeEntry(dropped);
			this.elided++;
		}
	}
}

/**
 * Release timers held by an entry, if it has any.
 *
 * Only the tool view animates, so only it needs releasing; the narrower
 * signature on `Component` means the check has to be explicit rather than an
 * optional call.
 */
function disposeEntry(entry: TranscriptEntry): void {
	if (entry.kind === "tool") entry.view.dispose();
}
