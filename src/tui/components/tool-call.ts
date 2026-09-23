/**
 * Tool call view.
 *
 * One tool invocation, rendered as a compact header plus its output. The
 * behaviour differs by state on purpose:
 *
 * - While running, output is shown live (the tail, so progress is visible as it
 *   happens). This is what makes a long `bash` call legible instead of a freeze.
 * - Once finished, the same tail view is kept but a hint reports the full line
 *   count, so the transcript stays scannable without hiding anything.
 * - `ctrl+o` expands to the complete output.
 *
 * Tail rather than head is deliberate: it matches how pi itself truncates tool
 * output, and the end of a command's output is where errors appear.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { primaryToolArgument, toolResultText } from "../../kernel/events.ts";
import type { TuiTheme } from "../theme.ts";

export type ToolStatus = "running" | "ok" | "error";

/** Lines shown in the collapsed view. */
const COLLAPSED_LINES = 6;

/** Hard cap on retained output, so a runaway command cannot exhaust memory. */
const MAX_BUFFERED_LINES = 2000;

/** Spinner frames for the running state. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Indent applied to output lines, aligned under the header text. */
const OUTPUT_INDENT = "  ";

export interface ToolCallViewOptions {
	name: string;
	args: unknown;
	/** Start collapsed. Defaults to true. */
	collapsed?: boolean;
}

export class ToolCallView implements Component {
	private readonly tui: TUI;
	private readonly theme: TuiTheme;
	private readonly name: string;
	private readonly argument: string | undefined;

	private status: ToolStatus = "running";
	private lines: string[] = [];
	private collapsed: boolean;
	private truncatedFromHead = false;

	private spinnerFrame = 0;
	private spinnerTimer: NodeJS.Timeout | undefined;

	constructor(tui: TUI, theme: TuiTheme, options: ToolCallViewOptions) {
		this.tui = tui;
		this.theme = theme;
		this.name = options.name;
		this.argument = primaryToolArgument(options.args);
		this.collapsed = options.collapsed ?? true;
		this.startSpinner();
	}

	// ---------------------------------------------------------------- mutation

	/** Replace the buffered output with a fresh partial result. */
	setOutput(text: string): void {
		this.lines = text.length === 0 ? [] : text.split("\n");
		if (this.lines.length > MAX_BUFFERED_LINES) {
			this.lines = this.lines.slice(-MAX_BUFFERED_LINES);
			this.truncatedFromHead = true;
		}
		this.tui.requestRender();
	}

	/** Mark the tool finished. */
	finish(result: unknown, isError: boolean): void {
		this.status = isError ? "error" : "ok";
		const text = toolResultText(result);
		if (text.length > 0) this.setOutput(text);
		this.stopSpinner();
		this.tui.requestRender();
	}

	/** Mark the tool failed without a result payload. */
	fail(message: string): void {
		this.status = "error";
		if (message.length > 0) this.setOutput(message);
		this.stopSpinner();
		this.tui.requestRender();
	}

	toggleExpanded(): boolean {
		this.collapsed = !this.collapsed;
		this.tui.requestRender();
		return !this.collapsed;
	}

	setExpanded(expanded: boolean): void {
		this.collapsed = !expanded;
		this.tui.requestRender();
	}

	get isExpanded(): boolean {
		return !this.collapsed;
	}

	get toolName(): string {
		return this.name;
	}

	/** Stop the animation timer. Must be called when the view is discarded. */
	dispose(): void {
		this.stopSpinner();
	}

	// ----------------------------------------------------------------- private

	private startSpinner(): void {
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		// Do not hold the event loop open on the timer alone.
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	private marker(): string {
		if (this.status === "running") {
			return this.theme.accent(SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0]!);
		}
		if (this.status === "error") return this.theme.error("✗");
		return this.theme.accent("⏺");
	}

	private header(): string {
		const parts = [this.marker(), this.theme.text(this.name)];
		if (this.argument) parts.push(this.theme.dim(this.argument));
		return parts.join(" ");
	}

	/** Lines to display given the current collapse state. */
	private visibleOutput(): { lines: string[]; hiddenCount: number } {
		if (this.collapsed && this.lines.length > COLLAPSED_LINES) {
			return {
				lines: this.lines.slice(-COLLAPSED_LINES),
				hiddenCount: this.lines.length - COLLAPSED_LINES,
			};
		}
		return { lines: this.lines, hiddenCount: 0 };
	}

	private footer(hiddenCount: number): string | undefined {
		const total = this.lines.length;
		if (this.collapsed && hiddenCount > 0) {
			const prefix = this.truncatedFromHead ? `${hiddenCount} earlier` : `${hiddenCount} more`;
			return this.theme.faint(`${OUTPUT_INDENT}└ … ${prefix} · ${total} lines total · ctrl+o to expand`);
		}
		if (!this.collapsed && total > COLLAPSED_LINES) {
			return this.theme.faint(`${OUTPUT_INDENT}└ ${total} lines · ctrl+o to collapse`);
		}
		return undefined;
	}

	// -------------------------------------------------------------- Component

	render(width: number): string[] {
		if (width <= 0) return [];
		const out: string[] = [truncateToWidth(this.header(), width, "…")];

		const { lines, hiddenCount } = this.visibleOutput();
		if (lines.length > 0) {
			const gutter = this.theme.faint(`${OUTPUT_INDENT}│ `);
			const gutterWidth = visibleWidth(gutter);
			const contentWidth = Math.max(1, width - gutterWidth);
			for (const line of lines) {
				// Output can contain very long lines (minified files, wide tables).
				// Truncate rather than wrap: wrapping would make the transcript
				// height unpredictable and bury the header.
				out.push(gutter + truncateToWidth(line, contentWidth, "…"));
			}
		}

		const footer = this.footer(hiddenCount);
		if (footer) out.push(footer);

		return out;
	}

	invalidate(): void {
		// Nothing cached; render is computed per call.
	}
}
