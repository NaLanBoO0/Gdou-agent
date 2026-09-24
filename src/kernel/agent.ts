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
import { loadSkills } from "../skills/registry.ts";
import type { Skill } from "../skills/types.ts";
import { loadSkillTool } from "../tools/load-skill.ts";
import { delegateTool } from "../tools/delegate.ts";
import { askUserTool, type AskUserQuestion } from "../tools/ask-user.ts";
import { MUTATING_TOOLS, snapshotBefore, summarizeChange } from "./changes.ts";
import { CONTEXT_BUDGET_CHARS, type ContextStatus, pruneForContext } from "./context.ts";
import { translate, type AgentEvent, type AgentEventListener } from "./events.ts";
import { type FallbackReport, withModelFallback } from "./fallback.ts";
import { LoopGuard, DEFAULT_LOOP_REPEAT_LIMIT, loopBlockReason } from "./loop-guard.ts";
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
import { connectMcp } from "../mcp/index.ts";

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
	/**
	 * Pre-loaded settings.
	 *
	 * Loaded by the caller, not here: `resolveSetup` defaults an omitted value to
	 * an empty object, so every preference (model, thinking level, permission
	 * tier, fallback, loop guard) must be handed in by whoever builds the
	 * session. The Electron entry once omitted this and `agent:setModel` saved a
	 * choice to disk that the rebuilt session then ignored — the model resolved
	 * from the mode default instead of what the user had just picked. CLI and
	 * Electron both pass `loadSettings()` explicitly.
	 */
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
	/**
	 * Model spec to retry on when the primary fails before producing output.
	 *
	 * Falls back to settings, then to no fallback at all. See
	 * `kernel/fallback.ts` for why "before producing output" is the condition
	 * rather than "whenever it fails".
	 */
	fallbackModel?: string;
	/**
	 * How many consecutive identical tool calls to allow. `0` disables the check.
	 *
	 * Falls back to settings, then to `DEFAULT_LOOP_REPEAT_LIMIT`.
	 */
	loopRepeatLimit?: number;
	/**
	 * Whether this session may spawn sub-agents via the `delegate` tool.
	 *
	 * Defaults to true for a top-level session; a sub-agent passes `false` so it
	 * cannot spawn sub-agents of its own, which turns "delegate everything" from
	 * an unbounded tree into exactly one level of delegation.
	 */
	includeDelegate?: boolean;
	/**
	 * How this session asks the user a question mid-run.
	 *
	 * Omitted, the `ask_user` tool is not mounted and the model can only ask in
	 * prose (which the user answers in the composer like any other message). A
	 * caller that has a question channel — the bridge's multi-choice dialog —
	 * passes a function that transports the questions and resolves with the
	 * answer text; `execute` holds the run open until then.
	 */
	askUser?: (questions: AskUserQuestion[]) => Promise<string>;
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
	/**
	 * The skills available to this session, in the same order they appear in the
	 * prompt catalog.
	 *
	 * Exposed so a front-end can show "these skills are on offer" without
	 * duplicating the loader. Only names and summaries, never the bodies — the
	 * bodies are fetched on demand by the model through `load_skill`.
	 */
	readonly skills: Skill[];
	/**
	 * Skill directories that exist but could not be loaded, with the reason.
	 *
	 * Reported rather than dropped for the same reason the expert catalog does:
	 * a silently missing skill looks exactly like a typo in the id.
	 */
	readonly skillErrors: string[];
	/**
	 * MCP servers that failed to connect, as `name: reason`.
	 *
	 * Same reporting discipline as `skillErrors`: a server the user configured
	 * but that did not come up should be visible, not silently absent — its tools
	 * missing otherwise looks like the config was never read.
	 */
	readonly mcpErrors: Record<string, string>;
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
	/**
	 * The model a failed request will be retried on, when one is configured.
	 *
	 * Exposed rather than kept internal so a front-end can disclose it before it
	 * is ever used: a reply that quietly came from a different model than the one
	 * on the status line is the sort of thing a user should have been told about
	 * in advance.
	 */
	readonly fallback?: Model<string>;
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
	/** Resolved fallback model, or undefined when none is configured. */
	fallback?: Model<string>;
	cwd: string;
	thinkingLevel: ThinkingLevel;
	toolExecution: "parallel" | "sequential";
	policy: PermissionPolicy;
	loopRepeatLimit: number;
	/** Skill ids the user has turned off; hidden from this session's catalog. */
	disabledSkills: ReadonlySet<string>;
}

function missingCredentialsError(): Error {
	const report = ModelRuntime.create().credentialReport();
	return new Error(
		[
			"No model available: no provider has a credential.",
			"",
			"Add one in the interface (设置 → 模型与凭据), or set an environment variable and retry:",
			report,
			"",
			'Example (PowerShell):  $env:DEEPSEEK_API_KEY="sk-..."',
			"Example (bash):        export DEEPSEEK_API_KEY=sk-...",
		].join("\n"),
	);
}

function resolveSetup(options: CreateAgentOptions): ResolvedSetup {
	const settings = options.settings ?? {};

	// cwd is resolved before both the mode and the expert because both are found
	// partly relative to it: project-level mode and expert files live beside the
	// code they describe, so the working directory is an input to which
	// definitions even exist.
	const cwd = options.cwd ?? settings.cwd ?? process.cwd();

	// `recipe.mode` and `settings.mode` are the same thing: the mode id. The
	// settings field used to be called `profile`; the loader still reads that
	// name so an existing file keeps working.
	const modeId = options.recipe?.mode ?? settings.mode ?? FALLBACK_PROFILE_ID;
	const profile = getProfile(modeId, cwd);

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

	// Precedence: an explicit call-site spec, then the stored preference, then
	// the mode's own. The mode is last because it is the shipped-or-shared
	// layer: a file that pins a model should not override a choice the user
	// made for themselves.
	const modelSpec = options.model ?? settings.model ?? profile.model;
	// Whether the spec actually came from the mode file, as opposed to merely
	// being equal to it. A user who types a spec that happens to match their
	// mode's must be told about *their* typo, not handed the mode's file path.
	const fromMode = options.model === undefined && settings.model === undefined && profile.model !== undefined;
	let model: Model<string> | undefined;
	try {
		model = runtime.resolveDefault(modelSpec);
	} catch (error) {
		// A mode may name a model, and the failure that produces is a bad line in
		// a mode file — not a bad setting. Reported as such, because "Unknown
		// model" on its own sends the reader through settings and the environment
		// looking for a spec that lives somewhere else entirely.
		if (fromMode) {
			throw new Error(
				`Mode "${profile.id}" names a model that does not exist: ${modelSpec}` +
					`\n  (from ${profile.source ?? "a mode supplied in code"})`,
			);
		}
		throw error;
	}
	if (!model) throw missingCredentialsError();

	// Resolved eagerly for the same reason the primary is: an unknown spec should
	// fail when the session is built, not halfway through a reply that the
	// fallback was supposed to rescue. `resolveDefault` throws on an unknown
	// spec, so a configured fallback is either resolved here or the session
	// never starts — there is no "configured but unavailable" state to carry.
	const fallbackSpec = options.fallbackModel ?? settings.fallbackModel;
	let fallback: Model<string> | undefined;
	if (fallbackSpec) {
		try {
			fallback = runtime.resolveDefault(fallbackSpec);
		} catch (error) {
			// Named as a fallback, because "Unknown model: x" alone reads like
			// the primary is broken — and the primary is fine.
			throw new Error(`The fallback model does not exist: ${fallbackSpec}\n  (from fallbackModel)`, { cause: error });
		}
	}

	const recipe: SessionRecipe = { mode: profile.id };
	if (expert) recipe.expert = expert.id;

	return {
		recipe,
		profile,
		expert,
		runtime,
		model,
		...(fallback ? { fallback } : {}),
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
		loopRepeatLimit: options.loopRepeatLimit ?? settings.loopRepeatLimit ?? DEFAULT_LOOP_REPEAT_LIMIT,
		disabledSkills: new Set(settings.disabledSkills ?? []),
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
 * The fallback wraps that transport rather than replacing it: retries first,
 * on the same model, because a transient blip is by far the likeliest failure
 * and switching models for it would trade a known-good model for an unknown
 * one. Only when the retries are exhausted does a different model get a turn.
 *
 * Exported so the injection can be asserted rather than assumed — the failure
 * mode is silent, and "the option is accepted" is not evidence that it reaches
 * the provider.
 */
export function defaultStreamFn(runtime: ModelRuntime, options: StreamFnOptions = {}): StreamFn {
	const attempts = options.maxRetries ?? DEFAULT_RETRY_ATTEMPTS;
	// `??` rather than plain assignment: an explicit per-call value should win,
	// but the usual case is that the agent passes nothing at all, and a plain
	// spread would then overwrite the default with `undefined`.
	const primary: StreamFn = (model, context, streamOptions) =>
		runtime.models.streamSimple(model, context, { ...streamOptions, maxRetries: streamOptions?.maxRetries ?? attempts });

	return withModelFallback(primary, { fallback: options.fallback, onFallback: options.onFallback });
}

export interface StreamFnOptions {
	/** Attempts made before giving up on a retryable failure. */
	maxRetries?: number;
	/** Model to retry on when the primary fails without producing output. */
	fallback?: Model<string>;
	/** Called once, at the moment of a switch. */
	onFallback?: (report: FallbackReport) => void;
}

/** Wire a resolved setup plus a concrete tool set into a usable session. */
function assemble(
	setup: ResolvedSetup,
	selection: ToolSelection,
	options: CreateAgentOptions,
	mcpTools: AnyTool[],
	mcpErrors: Record<string, string>,
	mcpClose: () => Promise<void>,
): AgentSession {
	const { recipe, profile, expert, runtime, model, fallback, cwd, thinkingLevel, toolExecution, policy, loopRepeatLimit, disabledSkills } =
		setup;
	const { tools, unavailable } = selection;

	// Skills are loaded here, once per session, and reduced to names + summaries
	// in the prompt. The bodies stay out until the model asks for them — that is
	// the entire cost win of progressive disclosure, and it is why the catalog is
	// injected as a list rather than concatenated. Skills the user turned off are
	// left out of that catalog (see `skills/registry.ts` for why an explicit
	// `load_skill` can still reach them).
	const skills = loadSkills(cwd, disabledSkills);

	// `load_skill` rides along with the mode's own tools. It is not part of the
	// mode's set because it is not a capability the mode decides — every session
	// can read a skill, since a skill is just instructions — and it is not
	// narrowed by the expert for the same reason: narrowing is about *capability*,
	// and reading instructions is not a capability in that sense. Computed once so
	// the session's reported tool list and the agent's actual tool list cannot
	// disagree about whether it exists.
	const allTools = [...tools, loadSkillTool(cwd)];
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

	/**
	 * Detects a model that is issuing the same call over and over.
	 *
	 * One instance per session, because the rule is about consecutive calls
	 * within one conversation — a count shared across sessions would refuse a
	 * legitimate first call. See `kernel/loop-guard.ts` for why the rule is
	 * consecutive rather than cumulative, and for the blind spot that buys.
	 */
	const loopGuard = new LoopGuard(loopRepeatLimit);

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

	// Hoisted so the delegate tool can hand the same transport to a sub-agent: a
	// sub-agent under a scripted run should stay scripted, not silently fall back
	// to a real provider that is not configured for the preview.
	const streamFn =
		options.streamFn ??
		defaultStreamFn(runtime, {
			maxRetries: options.maxRetries,
			fallback,
			// Announced at the moment of the switch, not afterwards: the whole
			// point of disclosing a fallback is that the user knows which model
			// wrote the reply they are reading. Telling them once it is over
			// would be a footnote rather than a disclosure. A caller-supplied
			// `streamFn` bypasses this entirely — the wrapper only exists on the
			// transport this module builds.
			onFallback: (report: FallbackReport) => {
				emit({
					type: "notice",
					message: `\`${report.from}\` 在产出任何内容之前就失败了（${report.reason}），已改用 \`${report.to}\` 重试。`,
				});
			},
		});

	// `delegate` rides along with `load_skill` in the session's tool list, but it
	// is opt-out: a sub-agent passes `includeDelegate: false` so it cannot spawn
	// sub-agents of its own, turning "delegate everything" from an unbounded tree
	// into exactly one level. Built here, after `streamFn`, so the sub-agent
	// inherits the same transport — a scripted run stays scripted.
	if (options.includeDelegate !== false) {
		allTools.push(delegateTool(cwd, recipe.mode, streamFn));
	}

	// `ask_user` is optional on purpose: it needs a question channel to talk to,
	// and a session without one should not advertise a tool that hangs forever.
	// Mounted here, next to `delegate`, because it is the same kind of
	// environment-provided capability — not a mode tool the expert narrows.
	if (options.askUser) {
		allTools.push(askUserTool(options.askUser));
	}

	// MCP tools ride along like `load_skill` and `delegate`: they are not a mode
	// capability the expert narrows, because they arrive from the environment the
	// user configured, not from the mode's contract. Every one is prefixed
	// `mcp__<server>__<tool>`, so it cannot collide with a built-in name.
	for (const tool of mcpTools) allTools.push(tool);

	const agent = new Agent({
		initialState: {
			systemPrompt: composePrompt(profile.systemPrompt({ cwd }), expert, skills.skills),
			model,
			thinkingLevel,
			// `load_skill` rides along with the mode's own tools, computed above.
			tools: allTools,
			// A resumed conversation already carries a leading system message, so
			// the agent leaves it alone rather than prepending a second one.
			messages: options.messages,
		},
		streamFn,
		toolExecution,
		// The permission gate. Attached at pi's `beforeToolCall` seam rather
		// than by wrapping the tools themselves: a wrapper would have to be
		// reapplied to every tool an expert or a mode contributes, and the one
		// that got missed would be the hole. This seam sees every call by
		// construction, including ones added later.
		beforeToolCall: async (context) => {
			// The gate asks the user when the call crosses its boundary. With an
			// approver wired in and an "ask" policy, actually go ask: an `ask`
			// that points at a live approval channel should not resolve to a
			// silent deny (that is only for "never"/no-channel).
			let decision = evaluateToolCall({ toolName: context.toolCall.name, args: context.args }, policy, permissionContext);
			if (decision.kind === "ask" && options.approver && policy.approval === "ask") {
				const approved = await options.approver({ toolName: context.toolCall.name, reason: decision.reason });
				decision = approved
					? { kind: "allow", stage: decision.stage, reason: decision.reason }
					: { kind: "deny", stage: decision.stage, reason: `${decision.reason}\n（用户拒绝了本次审批）` };
			}
			decision = resolveAsk(decision, policy, options.approver);

			if (decision.kind === "allow") {
				// Checked after the gate, never before, and that order carries
				// meaning: a call the permission chain refused never reaches the
				// provider, so it is not evidence of a stuck model. Counting it
				// would let a mode that is merely being denied look like a loop,
				// and blaming the model for the gate's answer is the wrong report.
				const repeat = loopGuard.record(context.toolCall.name, context.args);
				if (repeat.blocked) {
					const reason = loopBlockReason(context.toolCall.name, repeat.repeats);
					emit({ type: "notice", message: `已拦截 \`${context.toolCall.name}\`（重复调用）：${reason}` });
					return { block: true, reason };
				}

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
		tools: allTools,
		unavailableTools: unavailable,
		skills: skills.skills,
		skillErrors: skills.errors,
		mcpErrors,
		policy,
		denials,
		model,
		...(fallback ? { fallback } : {}),
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
			// MCP servers are child processes owned by this session; leaving them
			// running after the session is gone would leak them until the process
			// exits. Best-effort: a server that hangs on close is not worse than
			// the alternative of never trying.
			void mcpClose();
		},
	};
}

/**
 * Build a session. Async because a profile may construct tools asynchronously;
 * today the built-in profiles are synchronous, but the signature leaves room.
 */
export async function createAgent(options: CreateAgentOptions = {}): Promise<AgentSession> {
	const setup = resolveSetup(options);
	const modeTools = await setup.profile.tools({ cwd: setup.cwd });
	// The expert may only subtract from the mode's set — see `narrowTools` for
	// why that is a safety property and not a style preference.
	const selection = narrowTools(modeTools, setup.expert);
	// MCP servers are connected here, before the session is assembled, because a
	// server's tools must be known to mount them. A server that fails to connect
	// is reported (via `mcpErrors`) rather than aborting the session.
	const mcp = await connectMcp(setup.cwd);
	return assemble(setup, selection, options, mcp.tools, mcp.errors, mcp.close);
}

export type { AgentMessage, AgentEvent };
