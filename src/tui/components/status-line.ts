/**
 * Status line.
 *
 * One dim row: what mode you are in, which model is answering, where it is
 * pointed, and whether it is working. Everything here is secondary information,
 * so it stays dim and never competes with the transcript.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Separator between status fields. */
const SEPARATOR = " · ";

export class StatusLine implements Component {
	private readonly tui: TUI;
	private readonly theme: TuiTheme;

	private profileLabel = "";
	private expertLabel = "";
	private modelSpec = "";
	/** Model to retry on, rendered as `⇄ spec` after the model. Empty when none. */
	private fallbackSpec = "";
	private cwd = "";
	private working = false;
	private spinnerFrame = 0;
	private timer: NodeJS.Timeout | undefined;

	/** Transient message shown in place of the usual fields. */
	private hint = "";
	private hintTimer: NodeJS.Timeout | undefined;

	constructor(tui: TUI, theme: TuiTheme) {
		this.tui = tui;
		this.theme = theme;
	}

	setProfile(label: string): void {
		this.profileLabel = label;
		this.tui.requestRender();
	}

	/**
	 * Show the expert layered on the mode, or clear it with an empty string.
	 *
	 * Worth a field of its own rather than being folded into the mode label: the
	 * expert changes the method and can narrow the tool set, so "which one am I
	 * talking to" is not answerable from the mode alone.
	 */
	setExpert(label: string): void {
		this.expertLabel = label;
		this.tui.requestRender();
	}

	setModel(spec: string): void {
		this.modelSpec = spec;
		this.tui.requestRender();
	}

	/**
	 * Show the model a failed request would be retried on, or clear with "".
	 *
	 * Rendered immediately after the model rather than as a field of its own:
	 * the two are one fact — "who answers" — and a separator between them would
	 * read as two unrelated models being reported. Only shown when one is
	 * configured, on the same principle as the context indicator: a field that
	 * is always present becomes furniture and stops being read.
	 */
	setFallback(spec: string): void {
		this.fallbackSpec = spec;
		this.tui.requestRender();
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
		this.tui.requestRender();
	}

	/**
	 * Show a transient message, replacing the usual fields.
	 *
	 * Used for keybinding feedback ("expanded tool output") that would
	 * otherwise have to be pushed into the transcript, where it would become
	 * permanent clutter. It expires on its own so the caller does not have to
	 * remember to clear it.
	 */
	setHint(text: string, ttlMs = 2500): void {
		this.hint = text;
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
			this.hintTimer = undefined;
		}
		if (ttlMs > 0) {
			this.hintTimer = setTimeout(() => {
				this.hintTimer = undefined;
				this.hint = "";
				this.tui.requestRender();
			}, ttlMs);
			this.hintTimer.unref?.();
		}
		this.tui.requestRender();
	}

	/** Show or hide the working indicator. */
	setWorking(working: boolean): void {
		if (this.working === working) return;
		this.working = working;
		if (working) this.startTimer();
		else this.stopTimer();
		this.tui.requestRender();
	}

	dispose(): void {
		this.stopTimer();
		if (this.hintTimer) {
			clearTimeout(this.hintTimer);
			this.hintTimer = undefined;
		}
	}

	private startTimer(): void {
		this.timer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
		this.timer.unref?.();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		if (this.hint.length > 0) {
			return [this.theme.accent(truncateToWidth(this.hint, width, "…"))];
		}

		// The fallback rides along with the model rather than taking a slot of
		// its own, so the separator count stays the same whether one is set.
		const model = this.fallbackSpec ? `${this.modelSpec} ⇄${this.fallbackSpec}` : this.modelSpec;

		const left = [this.profileLabel, this.expertLabel, model, this.cwd]
			.filter((part) => part.length > 0)
			.join(SEPARATOR);

		if (!this.working) {
			return [this.theme.faint(truncateToWidth(left, width, "…"))];
		}

		const frame = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0]!;
		const right = `${frame} working`;
		const rightWidth = visibleWidth(right);
		const leftWidth = Math.max(0, width - rightWidth - 2);

		if (leftWidth === 0) {
			return [this.theme.accent(right)];
		}

		const leftText = truncateToWidth(left, leftWidth, "…");
		const padding = " ".repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth));
		return [this.theme.faint(leftText) + padding + this.theme.accent(right)];
	}

	invalidate(): void {}
}
