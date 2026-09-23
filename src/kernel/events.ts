/**
 * Normalized agent events.
 *
 * pi's `Agent` emits a detailed event stream tuned to its own TUI. A front-end
 * built directly on that stream is coupled to pi internals: any change upstream
 * reaches into the UI.
 *
 * This module defines a smaller, stable vocabulary and translates pi events into
 * it. The TUI we design later consumes `AgentEvent` only, so pi can be upgraded
 * underneath without touching presentation code.
 */

import type { AgentEvent as PiAgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextStatus } from "./context.ts";

/** Lifecycle and content events a front-end needs to render a run. */
export type AgentEvent =
	/** A run started. `messages` is the full history at this point. */
	| { type: "run_start"; messages: AgentMessage[] }
	/**
	 * A user message that belongs in the transcript.
	 *
	 * Live runs do not emit this: the front-end adds the bubble itself, before
	 * the run starts, so the message stays visible even if the run never does.
	 * Restored history emits it because there is no front-end action to rely on.
	 */
	| { type: "user_message"; text: string }
	/** The model began producing an assistant message. */
	| { type: "assistant_start" }
	/** Incremental assistant text. Concatenate deltas to build the message. */
	| { type: "text_delta"; text: string }
	/** Incremental reasoning text, when the model emits it. */
	| { type: "thinking_delta"; text: string }
	/** An assistant message finished. `stopReason` explains why. */
	| { type: "assistant_end"; stopReason: string }
	/** A tool call is about to execute. */
	| { type: "tool_start"; id: string; name: string; args: unknown }
	/** A tool streamed a partial result. */
	| { type: "tool_update"; id: string; name: string; partial: unknown }
	/** A tool finished, successfully or not. */
	| { type: "tool_end"; id: string; name: string; result: unknown; isError: boolean }
	/** One model turn plus its tool calls completed. */
	| { type: "turn_end" }
	/**
	 * Something the user should know that is not a failure.
	 *
	 * Currently raised when the conversation first outgrows the context budget:
	 * from that point the model is no longer shown everything, and without
	 * saying so the only symptom is a model that quietly forgets. A live signal
	 * only — `replay` never produces one, because it describes what is happening
	 * now rather than something that happened in the past.
	 */
	| { type: "notice"; message: string }
	/** The run finished. */
	| { type: "run_end"; messages: AgentMessage[] }
	/**
	 * How much of the conversation the model is being shown.
	 *
	 * A status update rather than something to draw: it belongs in a status line,
	 * not the transcript. Emitted when a run finishes, and also carried in the
	 * session description so a restored conversation reports its state before the
	 * first message is sent.
	 */
	| { type: "context_status"; status: ContextStatus }
	/** The run failed. */
	| { type: "error"; message: string };

export type AgentEventListener = (event: AgentEvent) => void;

/** Join the text blocks of a message content payload. */
export function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("");
}

/** Extract plain text from a pi assistant message's content blocks. */
function textOf(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return blocksToText(message.content);
}

/**
 * Replay stored messages as the events that would have produced them.
 *
 * Resuming a session means a front-end has to draw a conversation that already
 * happened. Emitting events for it keeps a single rendering path: the handler
 * that draws a live run draws restored history too, so the two cannot drift
 * apart as the interface grows.
 *
 * Tool calls live on the assistant message while their results arrive as
 * separate messages, so a call is opened where it is declared and closed when
 * its result shows up.
 */
export function replay(messages: readonly AgentMessage[]): AgentEvent[] {
	const events: AgentEvent[] = [];

	for (const message of messages) {
		switch (message.role) {
			case "user":
				events.push({ type: "user_message", text: blocksToText(message.content) });
				break;

			case "assistant": {
				events.push({ type: "assistant_start" });
				const text = textOf(message);
				if (text.length > 0) events.push({ type: "text_delta", text });
				events.push({ type: "assistant_end", stopReason: message.stopReason });
				if (message.stopReason === "error") {
					events.push({ type: "error", message: message.errorMessage ?? "The model request failed." });
				}
				for (const block of message.content) {
					if (block.type === "toolCall") {
						events.push({ type: "tool_start", id: block.id, name: block.name, args: block.arguments });
					}
				}
				break;
			}

			case "toolResult":
				events.push({
					type: "tool_end",
					id: message.toolCallId,
					name: message.toolName,
					// Reshaped to the same payload the live path delivers, so the
					// view's result extraction works unchanged.
					result: { content: message.content },
					isError: message.isError,
				});
				break;

			default:
				// System messages carry prompt and tool declarations, not
				// anything a conversation view draws.
				break;
		}
	}

	return events;
}

/**
 * Translate one pi event into zero or more normalized events.
 *
 * pi emits `message_update` for every delta of every block type, including
 * thinking and tool-call arguments. We surface only the deltas a UI renders;
 * tool arguments arrive complete via `tool_execution_start`.
 */
export function translate(event: PiAgentEvent): AgentEvent[] {
	switch (event.type) {
		case "agent_start":
			return [{ type: "run_start", messages: [] }];

		case "message_start":
			return event.message.role === "assistant" ? [{ type: "assistant_start" }] : [];

		case "message_update": {
			const inner = event.assistantMessageEvent;
			if (inner.type === "text_delta") return [{ type: "text_delta", text: inner.delta }];
			if (inner.type === "thinking_delta") return [{ type: "thinking_delta", text: inner.delta }];
			return [];
		}

		case "message_end": {
			if (event.message.role !== "assistant") return [];
			const events: AgentEvent[] = [{ type: "assistant_end", stopReason: event.message.stopReason }];
			// A provider failure arrives as an assistant message with stopReason
			// "error" and the reason on errorMessage. Without lifting it out here the
			// failure is invisible to any front-end that renders only deltas.
			if (event.message.stopReason === "error") {
				events.push({ type: "error", message: event.message.errorMessage ?? "The model request failed." });
			}
			return events;
		}

		case "tool_execution_start":
			return [{ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args }];

		case "tool_execution_update":
			return [
				{ type: "tool_update", id: event.toolCallId, name: event.toolName, partial: event.partialResult },
			];

		case "tool_execution_end":
			return [
				{
					type: "tool_end",
					id: event.toolCallId,
					name: event.toolName,
					result: event.result,
					isError: event.isError,
				},
			];

		case "turn_end":
			return [{ type: "turn_end" }];

		case "agent_end":
			return [{ type: "run_end", messages: event.messages }];

		default:
			return [];
	}
}

/** Best-effort text of an assistant message, for callers that need a summary. */
export { textOf };

/**
 * Extract display text from a raw tool result payload.
 *
 * Tools return `{ content: (TextContent | ImageContent)[], details }`. Both
 * `tool_update.partial` and `tool_end.result` carry this shape, but typed as
 * `unknown` because tools are heterogeneous. Views need the text, so this
 * narrows it once instead of every consumer doing it.
 */
export function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		else if (typed.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

/**
 * Pick the most informative single argument for a tool call, so the collapsed
 * view can show `read src/foo.ts` rather than the whole JSON payload.
 *
 * Numbers count: a `bash` call is identified by its command string, but a
 * paginated read is identified by its offset or limit, and showing the number
 * is the difference between a legible header and a bare tool name.
 */
export function primaryToolArgument(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	// Ordered by usefulness across the built-in tools.
	for (const key of ["path", "file_path", "command", "pattern", "query", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return undefined;
}
