/**
 * Message views.
 *
 * Both are intentionally plain. In a Codex-style transcript the assistant's own
 * markdown provides the visual structure, so the wrapper should add nothing
 * except a marker for user turns.
 */

import type { Component } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.ts";

/** Marker placed before a user turn. */
const USER_MARKER = "›";

/** Indent for continuation lines of a wrapped user message. */
const USER_INDENT = "  ";

/**
 * A user turn: one accent marker, then the text.
 *
 * User text is rendered verbatim rather than as markdown. People paste code,
 * diffs, and log output into prompts, and reinterpreting that as markdown
 * silently mangles it.
 */
export class UserMessageView implements Component {
	private readonly theme: TuiTheme;
	private text: string;

	constructor(theme: TuiTheme, text: string) {
		this.theme = theme;
		this.text = text;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const markerWidth = visibleWidth(USER_MARKER) + 1;
		const contentWidth = Math.max(1, width - markerWidth);
		const indent = " ".repeat(markerWidth);

		const out: string[] = [];
		const paragraphs = this.text.split("\n");
		for (const paragraph of paragraphs) {
			const wrapped = paragraph.length === 0 ? [""] : wrapTextWithAnsi(paragraph, contentWidth);
			for (const line of wrapped) {
				const isFirst = out.length === 0;
				const prefix = isFirst ? `${this.theme.accent(USER_MARKER)} ` : indent;
				out.push(prefix + truncateToWidth(line, contentWidth, "…"));
			}
		}
		return out.length > 0 ? out : [this.theme.accent(USER_MARKER)];
	}

	invalidate(): void {}
}

export interface AssistantMessageViewOptions {
	/** Reasoning text is rendered dim and italic when present. */
	showThinking?: boolean;
}

/**
 * An assistant turn: streamed markdown.
 *
 * Markdown is used throughout rather than switching to plain text while
 * streaming. A mid-flight switch reflows the transcript, and in a scrollback
 * based TUI that means content jumping under the reader. The markdown parser
 * tolerates partial input, including an unterminated code fence.
 */
export class AssistantMessageView implements Component {
	private readonly theme: TuiTheme;
	private readonly markdown: Markdown;
	private readonly showThinking: boolean;

	private textBuffer = "";
	private thinkingBuffer = "";
	private done = false;

	constructor(theme: TuiTheme, options: AssistantMessageViewOptions = {}) {
		this.theme = theme;
		this.showThinking = options.showThinking ?? true;
		this.markdown = new Markdown("", 0, 0, theme.markdown);
	}

	/** Append streamed assistant text. */
	appendText(delta: string): void {
		this.textBuffer += delta;
		this.markdown.setText(this.textBuffer);
	}

	/** Append streamed reasoning text. */
	appendThinking(delta: string): void {
		this.thinkingBuffer += delta;
	}

	/** Replace the whole message, e.g. when hydrating from history. */
	setText(text: string): void {
		this.textBuffer = text;
		this.markdown.setText(text);
	}

	/** Mark the turn complete. */
	finish(): void {
		this.done = true;
	}

	get hasContent(): boolean {
		return this.textBuffer.length > 0 || this.thinkingBuffer.length > 0;
	}

	render(width: number): string[] {
		const out: string[] = [];

		if (this.showThinking && this.thinkingBuffer.trim().length > 0) {
			// Thinking is folded to a single dim line. It is useful for debugging a
			// run but not part of the answer, so it should not push the answer down.
			const collapsed = this.thinkingBuffer.trim().replace(/\s+/g, " ");
			const label = this.theme.italic(this.theme.dim("thinking: "));
			const available = Math.max(1, width - visibleWidth(label));
			out.push(label + truncateToWidth(collapsed, available, "…"));
		}

		if (this.textBuffer.length > 0) {
			out.push(...this.markdown.render(width));
		} else if (!this.done && this.thinkingBuffer.length === 0) {
			out.push(this.theme.faint("…"));
		}

		return out;
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}
