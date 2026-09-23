/**
 * Agent construction.
 *
 * The single place where a runtime, a profile, and settings become a running
 * agent. Everything above this (CLI today, TUI later) talks to `AgentSession`
 * and never constructs a pi `Agent` itself, so there is exactly one wiring path
 * to keep correct.
 */

import { Agent, type AgentMessage, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ThinkingBudgets } from "@earendil-works/pi-ai";
import type { Settings } from "../config/settings.ts";
import { getExpert } from "../experts/registry.ts";
import type { Expert } from "../experts/types.ts";
import { FALLBACK_PROFILE_ID, getProfile } from "../profiles/registry.ts";
import type { AgentProfile, AnyTool } from "../profiles/types.ts";
import { MUTATING_TOOLS, snapshotBefore, summarizeChange } from "./changes.ts";
import { CONTEXT_BUDGET_CHARS, type ContextStatus, pruneForContext } from "./context.ts";
import { translate, type AgentEvent, type AgentEventListener } from "./events.ts";
import {
	type Approver,
	DEFAULT_PERMISSION_POLICY,
	defaultPermissionContext,
	evaluateToolCall,
	type PermissionPolicy,
	type PermissionStage,
	resolveAsk,
} from "./permission.ts";
import { composePrompt, narrowTools, type RecipeRequest, type SessionRecipe, type ToolSelection } from "./recipe.ts";
import { ModelRuntime } from "./runtime.ts";

export interface CreateAgentOptions {
	/**
	 * What to build: which mode, and optionally which expert.
	 *
	 * Omitted, the mode comes from settings and there is no expert. The two are
	 * one value rather than two options because that is what a session is — a
	 * combination — and because it is the value an automation will store.
	 */
	recipe?: RecipeRequest;
	/** Model spec as "provider/modelId". Falls back to settings, then env. */
	model?: string;
	/** Working directory for profile tools. Falls back to settings, then process.cwd(). */
	cwd?: string;
	/** Override the profile's suggested thinking level. */
	thinkingLevel?: ThinkingLevel;
	/** Override the global tool execution strategy. */
	toolExecution?: "parallel" | "sequential";
	/**
	 * Conversation to resume. These messages seed the session's history, so a
	 * stored session can be picked up where it left off rather than starting
	 * from an empty transcript.
	 */
	messages?: AgentMessage[];
	/** Pre-loaded settings. Loaded from disk when omitted. */
	settings?: Settings;
	/**
	 * Replace the streaming transport. Defaults to the resolved provider's HTTP
	 * transport. The model is still resolved normally, so a caller can swap in a
	 * local server, a proxy, or a scripted provider without changing anything
	 * else about the session.
	 */
	streamFn?: StreamFn;
	/**
	 * How much of the conversation may be sent to the model, in characters.
	 * Older turns beyond this are dropped from the request but stay in the
	 * transcript. Lowering it is mostly useful for testing the pruning path.
	 */
	contextBudgetChars?: number;
	/**
	 * Attempts to make after a provider request fails in a retryable way.
	 *
	 * Defaults to a small non-zero number. pi disables the provider SDK's own
	 * retries and defaults its own to zero, and `AgentOptions` has no
	 * `maxRetries` field at all — so without this, a single transient 429 or 500
	 * ends the run.
	 */
	maxRetries?: number;
	/**
	 * Per-level token budgets for reasoning, keyed by thinking level. pi has its
	 * own defaults; this only exists so a caller can raise or lower them.
	 */
	thinkingBudgets?: ThinkingBudgets;
	/**
	 * Identifier used for prompt-cache affinity.
	 *
	 * Providers that support cache routing key it on this, so two requests from
	 * the same conversation land on the same cache. Omitted, every request is a
	 * cold one.
	 */
	sessionId?: string;
	/** Initial listener, equivalent to calling subscribe() immediately after. */
	onEvent?: AgentEventListener;
	/**
	 * How much of the filesystem this session may change.
	 *
	 * Falls back to settings, then to `workspace-write`. The credential rules
	 * and the command guard are not affected by this — they hold at every tier,
	 * because a tier describes the filesystem, not permission to leak secrets.
	 */
	permission?: PermissionPolicy;
	/**
	 * Answers the `ask` decisions the chain produces.
	 *
	 * Omitted, every `ask` resolves to a denial. That is the deliberate
	 * direction: a gate that fails open is not a gate, and a front-end without
	 * an approval channel yet should refuse rather than silently permit.
	 */
	approver?: Approver;
}

/** A tool call the permission gate refused. */
export interface PermissionDenial {
	toolName: string;
	/** Which stage of the chain refused it. */
	stage: PermissionStage;
	reason: string;
}

/** A configured agent plus the metadata a front-end needs to describe it. */
export interface AgentSession {
	readonly agent: Agent;
	/** The recipe this session was built from. Ids only, so it can be stored. */
	readonly recipe: SessionRecipe;
	/** The resolved mode. */
	readonly profile: AgentProfile;
	/** The resolved expert, when the recipe named one. */
	readonly expert?: Expert;
	/**
	 * The tools this session actually exposes.
	 *
	 * Exposed because an expert may narrow the mode's set, and "the tool is
	 * missing" is otherwise indistinguishable from "the expert did not load".
	 */
	readonly tools: AnyTool[];
	/**
	 * Tool names the expert asked for that the mode does not provide.
	 *
	 * Session metadata rather than a `notice` event on purpose: this is known
	 * before any run happens, and every front-end subscribes *after*
	 * `createAgent` returns, so an event raised at construction time would be
	 * seen by nobody. It is a property of the session, so it is reported like
	 * one.
	 */
	readonly unavailableTools: string[];
	/** The permission policy this session enforces. */
	readonly policy: PermissionPolicy;
	/**
	 * Tool calls the gate refused, in order.
	 *
	 * Recorded rather than only streamed because the interesting case is
	 * "the agent stopped doing something and nobody said why" — a front-end
	 * needs to be able to show the list after the fact, not just watch it go by.
	 */
	readonly denials: PermissionDenial[];
	readonly model: Model<string>;
	readonly runtime: ModelRuntime;
	readonly cwd: string;
	/** Send a user message and wait for the whole run to finish. */
	prompt(text: string): Promise<void>;
	/** Subscribe to normalized events. Returns an unsubscribe function. */
	subscribe(listener: AgentEventListener): () => void;
	/** Abort the in-flight run. */
	abort(): void;
	/**
	 * What the model was shown on the last request, or undefined before one has
	 * been made — nothing has been sent yet, so there is nothing to report.
	 */
	contextStatus(): ContextStatus | undefined;
	/** Release listeners. The session is unusable afterwards. */
	dispose(): void;
}

/** Everything resolved from options and settings, before tools are built. */
interface ResolvedSetup {
	recipe: SessionRecipe;
	profile: AgentProfile;
	expert?: Expert;
	runtime: ModelRuntime;
	model: Model<string>;
	cwd: string;
	thinkingLevel: ThinkingLevel;
	toolExecution: "parallel" | "sequential";
	policy: PermissionPolicy;
}

function missingCredentialsError(): Error {
	const report = ModelRuntime.create().credentialReport();
	return new Error(
		[
			"No model available: none of the configured providers has an API key.",
			"",
			"Set one of these environment variables and retry:",
			report,
			"",
			'Example (PowerShell):  $env:DEEPSEEK_API_KEY="sk-..."',
			"Example (bash):        export DEEPSEEK_API_KEY=sk-...",
		].join("\n"),
	);
}

function resolveSetup(options: CreateAgentOptions): ResolvedSetup {
	const settings = options.settings ?? {};

	// cwd is resolved before the expert because project-level experts are found
	// relative to it, so the working directory is an input to which expert even
	// exists.
	const cwd = options.cwd ?? settings.cwd ?? process.cwd();

	// `recipe.mode` and `settings.mode` are the same thing: the mode id. The
	// settings field used to be called `profile`; the loader still reads that
	// name so an existing file keeps working.
	const modeId = options.recipe?.mode ?? settings.mode ?? FALLBACK_PROFILE_ID;
	const profile = getProfile(modeId);

	// Resolved eagerly so an unknown id fails here, with the list of known ones,
	// rather than silently producing a session that behaves like no expert.
	//
	// `null` means "explicitly none" and must not fall through to the stored
	// default — otherwise a UI could not offer "no expert" to a user who has one
	// set. See `RecipeRequest`.
	const requested = options.recipe?.expert;
	const expertId = requested === null ? undefined : (requested ?? settings.expert);
	const expert = expertId === undefined ? undefined : getExpert(expertId, cwd);

	const runtime = ModelRuntime.create();
	const model = runtime.resolveDefault(options.model ?? settings.model);
	if (!model) throw missingCredentialsError();

	const recipe: SessionRecipe = { mode: profile.id };
	if (expert) recipe.expert = expert.id;

	return {
		recipe,
		profile,
		expert,
		runtime,
		model,
		cwd,
		// Precedence is deliberate: an explicit call-site option wins, then the
		// user's stored preference, then the expert, then the mode's suggestion.
		// A stored setting that loses to a default is a setting that silently
		// does nothing — which is exactly what this ordering used to cause. The
		// expert sits above the mode because it is the more specific layer, and
		// below settings because the user's own choice outranks a file's.
		thinkingLevel:
			options.thinkingLevel ?? settings.thinkingLevel ?? expert?.thinkingLevel ?? profile.thinkingLevel ?? "off",
		toolExecution: options.toolExecution ?? settings.toolExecution ?? profile.toolExecution ?? "parallel",
		policy: options.permission ?? settings.permission ?? DEFAULT_PERMISSION_POLICY,
	};
}

/**
 * Attempts made after a retryable provider failure.
 *
 * Deliberately modest: enough to ride out a rate-limit blip, not so many that a
 * genuinely broken request takes minutes to surface.
 */
const DEFAULT_RETRY_ATTEMPTS = 2;

/**
 * The provider transport, with retries turned on.
 *
 * pi disables the provider SDK's own retries (`maxRetries: 0` at every call
 * site) and its own wrapper defaults to `maxRetries ?? 0`, so out of the box a
 * single transient 429 or 500 ends the run. `AgentOptions` exposes
 * `maxRetryDelayMs` but no `maxRetries`, so the count is injected here, at the
 * stream seam we already own.
 *
 * Exported so the injection can be asserted rather than assumed — the failure
 * mode is silent, and "the option is accepted" is not evidence that it reaches
 * the provider.
 */
export function defaultStreamFn(runtime: ModelRuntime, maxRetries?: number): StreamFn {
	const attempts = maxRetries ?? DEFAULT_RETRY_ATTEMPTS;
	// `??` rather than plain assignment: an explicit per-call value should win,
	// but the usual case is that the agent passes nothing at all, and a plain
	// spread would then overwrite the default with `undefined`.
	return (model, context, options) =>
		runtime.models.streamSimple(model, context, { ...options, maxRetries: options?.maxRetries ?? attempts });
}

/** Wire a resolved setup plus a concrete tool set into a usable session. */
function assemble(setup: ResolvedSetup, selection: ToolSelection, options: CreateAgentOptions): AgentSession {
	const { recipe, profile, expert, runtime, model, cwd, thinkingLevel, toolExecution, policy } = setup;
	const { tools, unavailable } = selection;

	const denials: PermissionDenial[] = [];
	const permissionContext = defaultPermissionContext(cwd);

	/**
	 * File contents captured before a mutating tool runs, keyed by call id.
	 *
	 * Needed because `write` reports nothing about what it replaced, so the only
	 * way to know what was removed is to have looked beforehand. Entries are
	 * deleted when the call finishes — this is per-call state, not a cache.
	 */
	const snapshots = new Map<string, string | undefined>();

	const listeners = new Set<AgentEventListener>();
	const emit = (event: AgentEvent) => {
		for (const listener of listeners) listener(event);
	};

	// Pruning happens inside the agent loop, which raises no events of its own.
	// The transform is the only place that knows the conversation outgrew the
	// budget, so it reports through the same listener set as everything else.
	//
	// Announced once, on the transition rather than on every request: after the
	// first time, saying it again each turn would be noise, and the point is to
	// explain the moment the model started forgetting — not to keep score.
	let announcedPruning = false;

	// What the model was actually shown on the last request, as opposed to what
	// it would be shown next. The two can differ — pruning turns itself off when
	// no safe cut exists — and a standing indicator that contradicts the notice
	// just shown is worse than one that lags by a turn.
	let lastContext: ContextStatus | undefined;

	const agent = new Agent({
		initialState: {
			systemPrompt: composePrompt(profile.systemPrompt({ cwd }), expert),
			model,
			thinkingLevel,
			tools,
			// A resumed conversation already carries a leading system message, so
			// the agent leaves it alone rather than prepending a second one.
			messages: options.messages,
		},
		streamFn: options.streamFn ?? defaultStreamFn(runtime, options.maxRetries),
		toolExecution,
		// The permission gate. Attached at pi's `beforeToolCall` seam rather
		// than by wrapping the tools themselves: a wrapper would have to be
		// reapplied to every tool an expert or a mode contributes, and the one
		// that got missed would be the hole. This seam sees every call by
		// construction, including ones added later.
		beforeToolCall: async (context) => {
			const decision = resolveAsk(
				evaluateToolCall({ toolName: context.toolCall.name, args: context.args }, policy, permissionContext),
				policy,
				options.approver,
			);

			if (decision.kind === "allow") {
				// Snapshot only for calls that are actually going to run: taking
				// one for a call the gate refuses would be a read with no
				// purpose, and the whole point of the gate is that it decides.
				if (MUTATING_TOOLS.has(context.toolCall.name)) {
					snapshots.set(context.toolCall.id, snapshotBefore(context.args, cwd));
				}
				return undefined;
			}

			denials.push({ toolName: context.toolCall.name, stage: decision.stage, reason: decision.reason });
			emit({
				type: "notice",
				message: `已拦截 \`${context.toolCall.name}\`（${decision.stage}）：${decision.reason}`,
			});

			// `block` turns the call into an error tool result, which is what the
			// model sees and reacts to. The reason goes in so it can pick a
			// different approach instead of retrying the same call.
			return { block: true, reason: decision.reason };
		},
		// Attach a line-level change summary to file mutations.
		//
		// Injected into the result's `details` rather than emitted as its own
		// event, so every front-end reads it from the same place it already
		// reads tool details — and `replay` reproduces it for free, because the
		// summary travels with the message that was stored.
		afterToolCall: async (context) => {
			if (!MUTATING_TOOLS.has(context.toolCall.name)) return undefined;
			const previous = snapshots.get(context.toolCall.id);
			snapshots.delete(context.toolCall.id);
			if (context.isError) return undefined;

			const details = context.result?.details as Record<string, unknown> | undefined;
			const change = summarizeChange(context.toolCall.name, context.args, previous, cwd, details);
			if (change === undefined) return undefined;
			return { details: { ...(details ?? {}), change } };
		},
		// Prompt-cache affinity: providers that support cache routing key it on
		// this, so requests from one conversation keep hitting the same cache.
		sessionId: options.sessionId,
		thinkingBudgets: options.thinkingBudgets,
		// Pruning happens on the way to the provider only. pi applies this
		// transform to a copy, so `state.messages` keeps the whole transcript:
		// what the user can scroll back through stays complete even when the
		// model is no longer being shown all of it.
		transformContext: async (messages) => {
			const budget = options.contextBudgetChars;
			const pruned = pruneForContext(messages, budget);

			lastContext = {
				total: messages.length,
				visible: pruned.length,
				visibleChars: pruned.reduce((sum, message) => sum + JSON.stringify(message).length, 0),
				budgetChars: budget ?? CONTEXT_BUDGET_CHARS,
			};

			if (!announcedPruning && pruned.length < messages.length) {
				announcedPruning = true;
				emit({
					type: "notice",
					message: `对话已超出上下文上限，模型现在只能看到最近 ${pruned.length} 条消息。上面的记录不受影响，仍然完整。`,
				});
			}
			return pruned;
		},
	});

	const unsubscribeAgent = agent.subscribe((event) => {
		for (const normalized of translate(event)) {
			emit(normalized);
			// Reported alongside the run's end so a front-end can keep a standing
			// indicator current without asking again after every turn.
			if (normalized.type === "run_end" && lastContext) {
				emit({ type: "context_status", status: lastContext });
			}
		}
	});
	if (options.onEvent) listeners.add(options.onEvent);

	return {
		agent,
		recipe,
		profile,
		expert,
		tools,
		unavailableTools: unavailable,
		policy,
		denials,
		model,
		runtime,
		cwd,
		async prompt(text: string) {
			await agent.prompt(text);
		},
		subscribe(listener: AgentEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		abort() {
			agent.abort();
		},
		contextStatus() {
			return lastContext;
		},
		dispose() {
			unsubscribeAgent();
			listeners.clear();
		},
	};
}

/**
 * Build a session. Async because a profile may construct tools asynchronously;
 * today both built-in profiles are synchronous, but the signature leaves room.
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<AgentSession> {
	const setup = resolveSetup(options);
	const modeTools = await setup.profile.tools({ cwd: setup.cwd });
	// The expert may only subtract from the mode's set — see `narrowTools` for
	// why that is a safety property and not a style preference.
	const selection = narrowTools(modeTools, setup.expert);
	return assemble(setup, selection, options);
}

export type { AgentMessage, AgentEvent };
