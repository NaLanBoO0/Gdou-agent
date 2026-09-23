/**
 * Context pruning.
 *
 * A conversation grows without bound: every tool result stays in the message
 * list, and the whole list goes to the model on every turn. A long coding
 * session therefore does not end with a slow reply, it ends with a provider
 * error about the context window.
 *
 * pi's simple `Agent` does not compact. It provides `transformContext` for
 * exactly this — its own documentation names "context window management
 * (pruning old messages)" as the use case — and it applies the transform to a
 * copy on the way to the provider, leaving `state.messages` untouched. That
 * split is the point: the conversation you can scroll back through stays
 * complete, while what the model is asked to consider stays bounded.
 *
 * What this costs: the model genuinely forgets. Older turns are gone from its
 * view rather than summarised, so the transcript on screen and the model's
 * working set are not the same thing. That is a real trade-off, and the reason
 * the budget is generous, reported by `--doctor`, and written down here rather
 * than left implicit.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * How much of the conversation may be sent, in characters of serialised JSON.
 *
 * Roughly a quarter of a million tokens for prose, though tool results are
 * denser. Deliberately well inside the context window of every model this
 * project ships with: the goal is to never hit the wall, not to fill the window.
 */
export const CONTEXT_BUDGET_CHARS = 1_000_000;

function sizeOf(message: AgentMessage): number {
	return JSON.stringify(message).length;
}

/**
 * Keep the most recent part of a conversation, dropping whole turns from the
 * front until it fits the budget.
 *
 * Two invariants matter more than the budget:
 *
 *   - The leading system message is always kept. It carries the prompt and the
 *     tool declarations; without it the model has no instructions at all.
 *   - The cut lands immediately before a user message. That is the only safe
 *     place: anywhere else can leave a `toolResult` whose `toolCall` has been
 *     dropped, which providers reject as a malformed conversation.
 *
 * When nothing can be cut the original list is returned unchanged: a single
 * turn cannot be trimmed without orphaning its tool results, and
 * `transformContext` is documented as "must not throw or reject".
 */
export function pruneForContext(messages: readonly AgentMessage[], budgetChars: number = CONTEXT_BUDGET_CHARS): AgentMessage[] {
	if (messages.length === 0) return [];

	const hasLeadingSystem = messages[0]?.role === "system";
	const leading = hasLeadingSystem ? [messages[0]] : [];
	const rest = hasLeadingSystem ? messages.slice(1) : [...messages];

	// Walk backwards, stopping as soon as the budget is exceeded, so the cost is
	// proportional to what is kept rather than to the length of the session.
	let used = 0;
	let cut = rest.length;
	for (let index = rest.length - 1; index >= 0; index--) {
		used += sizeOf(rest[index] as AgentMessage);
		if (used > budgetChars) {
			cut = index + 1;
			break;
		}
		cut = index;
	}

	// Everything fits.
	if (cut === 0) return [...messages];

	// Move forward to the next turn boundary. Keeping a little more is fine;
	// cutting mid-turn is not.
	let safe = cut;
	while (safe < rest.length && rest[safe]?.role !== "user") safe += 1;

	if (safe >= rest.length) {
		// No turn boundary after the cut, which means the budget is small enough
		// that the cut would land inside the last turn. Falling back to the start
		// of that turn keeps more than the budget allows, but it is still a valid
		// conversation — and pruning has to happen, or a request that exceeds the
		// window would be sent anyway and rejected for length. Without this
		// fallback pruning switches itself on and off, which makes both the
		// notice and any indicator derived from it report nonsense.
		safe = rest.length - 1;
		while (safe > 0 && rest[safe]?.role !== "user") safe -= 1;

		// A single turn cannot be trimmed without orphaning its tool results.
		if (safe <= 0) return [...messages];
	}

	return [...leading, ...rest.slice(safe)];
}

/** Whether pruning would drop anything, and how much. For diagnostics. */
export function contextReport(messages: readonly AgentMessage[], budgetChars: number = CONTEXT_BUDGET_CHARS): string {
	const pruned = pruneForContext(messages, budgetChars);
	const used = messages.reduce((total, message) => total + sizeOf(message), 0);
	return `${messages.length} 条消息 / ${Math.round(used / 1024)} KB，上限 ${Math.round(budgetChars / 1024)} KB，当前会裁到 ${pruned.length} 条`;
}

/** How much of the conversation the model is being shown. */
export interface ContextStatus {
	/** Messages in the transcript. */
	total: number;
	/** Messages the model would be shown on the next request. */
	visible: number;
	/** Serialised size of those messages, in characters. */
	visibleChars: number;
	/** The configured limit. */
	budgetChars: number;
}

/**
 * Summarise the split between the transcript and the model's view.
 *
 * This answers "what would be sent next", which is *not* the same question the
 * standing indicator asks. Pruning can switch itself off — when the budget is
 * small enough that the only cut available would land inside the last turn,
 * there is no safe place to cut and everything is sent — so a forward-looking
 * figure can contradict the notice that was just shown. The indicator reports
 * what was actually sent instead; this remains useful for diagnostics.
 */
export function contextStatusOf(
	messages: readonly AgentMessage[],
	budgetChars: number = CONTEXT_BUDGET_CHARS,
): ContextStatus {
	const visible = pruneForContext(messages, budgetChars);
	return {
		total: messages.length,
		visible: visible.length,
		visibleChars: visible.reduce((sum, message) => sum + sizeOf(message), 0),
		budgetChars,
	};
}
