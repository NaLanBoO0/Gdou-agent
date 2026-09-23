/**
 * Retrying a request on a second model.
 *
 * A provider that is overloaded, or a region having a bad afternoon, takes the
 * whole conversation down with it. The fallback exists so a session survives one
 * provider's outage instead of ending with an error the user can do nothing
 * about.
 *
 * **The condition is "failed before producing anything", and that is the whole
 * difficulty.** Once a reply has started streaming, the user has seen it. Quietly
 * restarting on another model would either duplicate the opening of the answer or
 * replace text that is already on screen — so a failure *after* the first token
 * is passed straight through as the error it is. A fallback is a rescue, not a
 * rewrite.
 *
 * This lives at the `StreamFn` seam rather than inside the agent loop because
 * that seam is the last place where "one request" is still one indivisible thing.
 * Below it we are an HTTP client; above it, the loop has already appended an
 * assistant message to the transcript.
 *
 * pi's contract for the seam is what keeps this module small: a `StreamFn` may
 * throw synchronously only for a pre-request failure, and **once a stream is
 * returned, failures must arrive as an `error` event**. So "did this request
 * produce anything" is answerable by watching the events, and there is no third
 * case to handle.
 *
 * The one invariant this file must never break: **the returned stream always
 * terminates.** pi's loop does `await response.result()` after the event
 * iterator finishes, and that promise only settles when a terminal event is
 * pushed (or `end(result)` is called). A relay that returns without either hangs
 * the session with no error and no reply — the worst possible failure, because
 * there is nothing to report.
 *
 * That invariant is unconditional, including when no fallback is configured, and
 * the reason is the shape of the failure it prevents. A wrapper that returned
 * its input untouched in the unconfigured case would make the guarantee
 * conditional on configuration — and its violation silent. Paying one relay for
 * an unconditional guarantee is the cheaper side of that trade.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** What a switch looks like from the outside, for the notice the user reads. */
export interface FallbackReport {
	/** Spec of the model that failed, as "provider/model". */
	from: string;
	/** Spec of the model being retried on. */
	to: string;
	/** Why the first attempt gave up. */
	reason: string;
}

export interface ModelFallbackOptions {
	/**
	 * The model to retry on.
	 *
	 * When absent the wrapper still relays, so the termination invariant holds
	 * either way; there is simply nothing to switch to, and a failure is
	 * reported instead of retried.
	 */
	fallback?: Model<string>;
	/** Called once, at the moment of the switch. */
	onFallback?: (report: FallbackReport) => void;
}

/** "provider/model", the spelling every other surface uses for a model. */
export function describeModel(model: Model<string>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * A protocol-valid error termination.
 *
 * Mirrors what pi builds when a provider fails to start, so the loop cannot tell
 * one of ours from one of its own. Only the fields the protocol requires are
 * filled in; usage is zero because nothing was billed, which is also true.
 */
function errorMessage(model: Model<string>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

type Sink = ReturnType<typeof createAssistantMessageEventStream>;
type Terminal = Extract<AssistantMessageEvent, { type: "error" }>;

/**
 * Anything except the opening `start` event counts as having produced something.
 *
 * This is both the test for "should we retry" and the commit point for the
 * withheld events — the two are the same question, which is why one predicate
 * answers both.
 *
 * Deliberately conservative. `start` carries a partial message with no content;
 * everything after it means the provider committed to a reply. Treating a
 * `text_start` with an empty string as "nothing happened" would risk restarting
 * over a reply the user can already see, and the cost of the safer reading is
 * only that we decline to rescue a failure we could have rescued.
 */
function producesContent(event: AssistantMessageEvent): boolean {
	return event.type !== "start";
}

interface PumpResult {
	produced: boolean;
	/** The terminal error, withheld from the sink so the caller can decide. */
	error?: Terminal;
}

/**
 * Forward `source` into `sink` until it terminates, withholding the opening
 * events until the attempt is committed to producing something.
 *
 * **The withholding is required for correctness, not an optimisation.** pi's
 * loop reads `start` as "a new assistant message begins here": it appends the
 * partial message to the conversation and emits `message_start`. A relay that
 * forwarded the failed attempt's `start` and then the fallback's would leave two
 * assistant messages in the transcript — the first an empty partial that no
 * terminal event ever closes, and a duplicate bubble in every front-end.
 *
 * A terminal `error` is *returned* rather than pushed, because the caller is the
 * one that decides whether to relay it or to retry. `done` goes straight
 * through — there is nothing to decide about a success.
 *
 * A source that ends without any terminal event is turned into an error rather
 * than reported as a silent stop: pi's contract says it cannot happen, so the
 * honest thing is to say so instead of letting the loop infer it from an
 * absence. The synthesized error is withheld like any other, so that every path
 * through this module pushes exactly one terminal event.
 *
 * Note the consequence for the caller: when this returns an error with
 * `produced: false`, *nothing at all* has reached the sink. The caller can
 * safely start a second attempt in its place.
 */
async function pump(source: AsyncIterable<AssistantMessageEvent>, sink: Sink, model: Model<string>): Promise<PumpResult> {
	let produced = false;
	let committed = false;
	let pending: AssistantMessageEvent[] = [];

	const commit = () => {
		committed = true;
		for (const event of pending) sink.push(event);
		pending = [];
	};

	for await (const event of source) {
		if (event.type === "done") {
			commit();
			sink.push(event);
			return { produced };
		}
		if (event.type === "error") return { produced, error: event };
		if (producesContent(event)) {
			produced = true;
			commit();
		}
		if (committed) sink.push(event);
		else pending.push(event);
	}
	const message = errorMessage(model, new Error("the provider stream ended without a final message"));
	return { produced, error: { type: "error", reason: "error", error: message } };
}

/**
 * Wrap `stream` so a request that fails before producing output is retried on
 * `options.fallback`.
 *
 * **`stream` must dispatch on the model it is handed.** The wrapper does not
 * swap in a different transport for the second attempt — it calls the same
 * function with a different model, because that is what a transport *is*: a
 * layer that turns (model, context) into a stream. A transport that ignores its
 * model argument would "fall back" to itself, and the only symptom would be a
 * repeated failure. `defaultStreamFn` in `agent.ts` is the intended subject and
 * does dispatch; the requirement is stated here because a wrapper that silently
 * cannot work is worse than one that cannot be written.
 *
 * The returned function keeps the `StreamFn` contract: it yields one event
 * stream, and every failure after the stream exists is encoded in that stream.
 */
export function withModelFallback(stream: StreamFn, options: ModelFallbackOptions): StreamFn {
	const fallback = options.fallback;

	return async (model, context, streamOptions) => {
		const primaryModel = model as Model<string>;

		// Awaited *before* the relay starts so a pre-request throw rejects the
		// returned promise, which is what the contract says a synchronous failure
		// looks like. Once this line has passed, nothing below is allowed to
		// escape — see the `relay` wrapper.
		const primary = await stream(model, context, streamOptions);
		const sink = createAssistantMessageEventStream();

		const relay = async (): Promise<void> => {
			const first = await pump(primary, sink, primaryModel);

			if (!first.error) return;

			// Two reasons to report the error rather than retry. The user has
			// already seen part of the reply, so a second model's answer would
			// arrive as a continuation of it; or there is no second model to try.
			if (first.produced || !fallback) {
				sink.push(first.error);
				return;
			}

			options.onFallback?.({
				from: describeModel(primaryModel),
				to: describeModel(fallback),
				reason: first.error.error.errorMessage ?? first.error.reason,
			});

			try {
				const retry = await stream(fallback, context, streamOptions);
				const second = await pump(retry, sink, fallback);
				if (second.error) sink.push(second.error);
			} catch (error) {
				// The fallback could not start either. Reported as *its* failure,
				// because that is the news — the primary's error was already
				// reported through `onFallback`, and repeating it would suggest the
				// retry never happened.
				const message = errorMessage(fallback, error);
				sink.push({ type: "error", reason: "error", error: message });
			}
		};

		void relay().catch((error: unknown) => {
			// Last resort, and the reason this catch exists at all: the stream must
			// end. A relay that rejects without terminating leaves `result()`
			// pending and the session waiting forever.
			const message = errorMessage(primaryModel, error);
			sink.push({ type: "error", reason: "error", error: message });
		});

		return sink;
	};
}
