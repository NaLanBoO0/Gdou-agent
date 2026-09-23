/**
 * Notices.
 *
 * Short standalone lines that belong in the transcript but carry no
 * conversation semantics: the startup banner, an error from the provider, a
 * status message from the UI itself. Kept apart from the message views because
 * the model and the user are not the ones speaking here.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.ts";

export type NoticeTone = "plain" | "dim" | "error" | "warning" | "success";

export interface NoticeViewOptions {
	tone?: NoticeTone;
	/** Leading indent in spaces. Continuation lines align to it. Defaults to 0. */
	indent?: number;
}

/**
 * A wrapped, tonally styled block of text.
 *
 * Styling is applied per wrapped line rather than to the whole string before
 * wrapping: an ANSI escape sequence counted as zero columns by the wrapper is
 * still a fine thing to wrap around, but re-styling each line keeps the
 * terminal from carrying one open colour across the whole block.
 */
export class NoticeView implements Component {
	private readonly theme: TuiTheme;
	private readonly tone: NoticeTone;
	private readonly indent: number;
	private text: string;

	constructor(theme: TuiTheme, text: string, options: NoticeViewOptions = {}) {
		this.theme = theme;
		this.text = text;
		this.tone = options.tone ?? "plain";
		this.indent = options.indent ?? 0;
	}

	setText(text: string): void {
		this.text = text;
	}

	private style(line: string): string {
		switch (this.tone) {
			case "dim":
				return this.theme.dim(line);
			case "error":
				return this.theme.error(line);
			case "warning":
				return this.theme.warning(line);
			case "success":
				return this.theme.success(line);
			default:
				return this.theme.text(line);
		}
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const pad = " ".repeat(Math.min(this.indent, Math.max(0, width - 1)));
		const contentWidth = Math.max(1, width - pad.length);

		const out: string[] = [];
		for (const paragraph of this.text.split("\n")) {
			if (paragraph.length === 0) {
				out.push("");
				continue;
			}
			for (const line of wrapTextWithAnsi(paragraph, contentWidth)) {
				out.push(this.style(pad + line));
			}
		}
		return out;
	}

	invalidate(): void {}
}

/**
 * Fixed, pre-styled lines that are emitted verbatim.
 *
 * For content where each line already carries its own emphasis and wrapping
 * would be wrong - the startup banner, where a title line is bold and the hint
 * line beneath it is dim, and both are short by construction.
 */
export class StaticView implements Component {
	private readonly lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.lines.map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {}
}
