/**
 * Repeated-call detection.
 *
 * The failure mode this exists for: a model, usually a small one, decides that a
 * tool call is the answer, gets a result it does not like, and issues the
 * identical call again. Nothing about the second call differs from the first, so
 * nothing about the result will either. Without a guard the loop runs until the
 * user notices the transcript filling up with the same call.
 *
 * The refusal is delivered as a blocked tool call rather than as a message
 * injected into the transcript. That is deliberate: pi turns a `block` into an
 * error tool result, which is a shape the model already knows how to react to —
 * it arrives in the same place as every other tool result, carrying the reason.
 * Injecting prose would need a channel that does not exist and would look like
 * the user said it.
 *
 * **The rule is consecutive, not cumulative, and that distinction is the whole
 * design.** The same call repeated N times *in a row* is a stuck model. The same
 * call repeated N times across a session is often just work: run the tests, edit,
 * run the tests again. A cumulative counter would refuse the fourth `npm test`,
 * which is a normal afternoon.
 *
 * The cost of that choice is a blind spot, and it is worth naming rather than
 * discovering later: an alternating loop (`read A`, `read B`, `read A`, `read B`)
 * resets the count on every call and is never caught. Catching it needs a notion
 * of "no new information arrived", which this module deliberately does not have.
 */

/** How many consecutive identical calls are allowed through. */
export const DEFAULT_LOOP_REPEAT_LIMIT = 3;

export interface LoopDecision {
	/** How many times this exact call has now been attempted in a row. */
	repeats: number;
	/**
	 * Whether the call should be refused.
	 *
	 * True on the attempt *after* the limit — the stated limit is how many are
	 * allowed to run, not how many are allowed before the first refusal. Two
	 * counters with the same number meaning different things is how off-by-one
	 * bugs get shipped.
	 */
	blocked: boolean;
}

/**
 * Order-insensitive serialization of a call's arguments.
 *
 * Object key order is not semantically meaningful in JSON but it is preserved by
 * `JSON.stringify`, and a model that emits the same arguments in a different key
 * order each time would otherwise look like a different call every time — which
 * is precisely the loop this module is trying to see.
 *
 * Values that cannot be serialized (a circular structure, a function) fall back
 * to a stable type tag. The guard then compares those calls as equal, which errs
 * toward catching the loop; refusing a call that was in fact different is
 * recoverable, letting a loop run is not.
 */
export function callKey(toolName: string, args: unknown): string {
	return `${toolName}\u0000${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return typeof value === "function" ? "[function]" : JSON.stringify(value) ?? "undefined";
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => typeof entry !== "function")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/** What the model is told when a call is refused. */
export function loopBlockReason(toolName: string, repeats: number): string {
	return [
		`\`${toolName}\` 已经被用同样的参数连续调用了 ${repeats} 次，结果不会因为你再调一次而改变。`,
		"停下来，用已经拿到的结果继续；确实需要再调用的话，换参数或者换一个工具。",
	].join("");
}

/**
 * Per-session state for the consecutive-repeat rule.
 *
 * A guard instance belongs to one session, never to a process: two conversations
 * happening at once must not see each other's call history, and a count that
 * survived into the next conversation would refuse a legitimate first call.
 */
export class LoopGuard {
	private lastKey: string | undefined;
	private repeats = 0;
	private readonly limit: number;

	/** `0` (or negative) disables the guard entirely. */
	constructor(limit: number = DEFAULT_LOOP_REPEAT_LIMIT) {
		this.limit = limit;
	}

	/** Whether this guard will ever refuse anything. */
	get enabled(): boolean {
		return this.limit > 0;
	}

	/** How many consecutive identical calls are allowed through. */
	get repeatLimit(): number {
		return this.limit;
	}

	/**
	 * Record an attempt and decide.
	 *
	 * Called only for calls that made it past the permission gate. A refused call
	 * must not count toward the limit: the model reacting to a denial by trying
	 * the same thing again is a different problem, and that one is already being
	 * reported by the gate on every attempt.
	 */
	record(toolName: string, args: unknown): LoopDecision {
		const key = callKey(toolName, args);
		if (key === this.lastKey) {
			this.repeats += 1;
		} else {
			this.lastKey = key;
			this.repeats = 1;
		}
		return { repeats: this.repeats, blocked: this.enabled && this.repeats > this.limit };
	}
}
