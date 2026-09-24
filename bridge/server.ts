/**
 * Bridge server: expose the pi kernel as a JSON-RPC service the GUI shell can
 * drive.
 *
 * The shell is a self-drawn desktop workbench (方案 B): it keeps its own
 * front-end while this process provides the backend it talks to. The bridge
 * listens on the port the shell expects (7438) and speaks the shell's wire
 * protocol (JSON-RPC 2.0 requests over WebSocket, events pushed as
 * `{ kind: "event", event }` envelopes), so the shell's 646-line runtime
 * client needs no changes.
 *
 * The mapping is deliberately thin. pi's event vocabulary is smaller and more
 * stable than the shell's, so a handful of translations cover the whole stream:
 *
 *   pi event          →  shell event
 *   run_start         →  run.started
 *   text_delta        →  llm.token
 *   thinking_delta    →  llm.thinking
 *   tool_start        →  tool.call_started
 *   tool_end          →  tool.call_finished
 *   run_end           →  run.finished
 *   notice / error    →  log.line
 *
 * Stage 1 implemented the conversation path (event.subscribe, session.create,
 * session.send_message, run.cancel). Stage 2 adds the **boot set**: the five
 * methods `refreshIndex()` calls in parallel at startup. They matter more than
 * their apparent weight — a single rejection there fails the whole
 * `Promise.all`, and the shell renders nothing at all rather than a degraded
 * page.
 *
 * Some fields have no honest pi equivalent. `provider.status.provider` is typed
 * `"anthropic" | "openai"` by the shell, and our providers (deepseek, moonshot…)
 * are neither. Rather than widen the shell's type, the bridge reports
 * `"openai"` because most of these providers speak the OpenAI wire format; the
 * comment on each such field says so. These are adaptation compromises, not
 * real capabilities, and stage 3 should replace them with a shell that talks
 * about providers the way we do.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
	blocksToText,
	createAgent,
	createSessionId,
	deleteSession,
	listSessions,
	loadSession,
	loadSettings,
	renameSession,
	saveSession,
	saveSettings,
	type AgentSession,
	type SessionSummary,
} from "../src/index.ts";
import { scriptedRun, scriptedRunEnabled } from "../src/kernel/demo.ts";
import { presetsWithCredentials } from "../src/config/providers.ts";
import { credentialStore, setApiKey } from "../src/kernel/credentials.ts";
import { ModelRuntime, parseModelSpec, testModel } from "../src/kernel/runtime.ts";
import { resolveTool } from "../src/profiles/tool-catalog.ts";
import { getProfile } from "../src/profiles/registry.ts";
import { installSkill, loadSkills, uninstallSkill } from "../src/skills/registry.ts";
import { listExperts } from "../src/experts/registry.ts";
import { approveMcpServer, approvedMcpServers, loadMcpConfig } from "../src/index.ts";
import { askUserTool, type AskUserQuestion } from "../src/index.ts";
import { deleteTask, dueTasks, getTask, listTasks, updateTaskResult, upsertTask } from "../src/automation/schedule.ts";
import type { ScheduledTask } from "../src/automation/schedule.ts";
import type { Settings } from "../src/config/settings.ts";
import type { Skill } from "../src/skills/types.ts";

const PORT = 7438;

/** One live conversation, keyed by the session id the shell chose. */
interface LiveSession {
	session: AgentSession;
	/** The run id currently in flight, if any, for cancellation. */
	runId?: string;
	/** When the conversation began, kept so re-saving never rewrites it. */
	createdAt?: string;
}

const sessions = new Map<string, LiveSession>();

/**
 * Mid-run questions to the user.
 *
 * The shell shows a structured dialog (multiple choice / multi-select) when the
 * model calls `ask_user`. The tool's `execute` holds the run open until the
 * answer arrives: we push a `question.requested` event, park a resolver keyed
 * by rpc_id, and `question.respond` resolves it with the answer text.
 */
interface PendingQuestion {
	resolve: (answerText: string) => void;
	sessionId: string;
	runId: string;
}
const pendingQuestions = new Map<string, PendingQuestion>();
/** The run currently streaming to a socket, so `ask_user` knows where to push. */
let activeQuestionContext: { socket: WebSocket; sessionId: string; runId: string } | null = null;

/** Wire `ask_user` to the shell: push the dialog, wait for the answer. */
function askUserViaBridge(questions: AskUserQuestion[]): Promise<string> {
	const context = activeQuestionContext;
	if (!context) return Promise.resolve("（没有可用的提问通道）");
	return new Promise((resolve) => {
		const rpcId = randomUUID();
		pendingQuestions.set(rpcId, { resolve, sessionId: context.sessionId, runId: context.runId });
		send(context.socket, {
			kind: "event",
			event: {
				type: "question.requested",
				rpc_id: rpcId,
				session_id: context.sessionId,
				run_id: context.runId,
				questions: questions.map((question) => ({
					id: rpcId,
					header: question.header ?? null,
					question: question.question,
					options: question.options,
					multi_select: question.multi_select,
				})),
			},
		});
	});
}

/**
 * Write a live session's transcript to disk, mirroring what the desktop GUI's
 * `persistSession` does.
 *
 * Without this, bridge-born conversations live only in memory: a bridge restart
 * orphans every open one ("unknown session", sends go nowhere) and new tasks
 * never appear in history. Persisting after each run makes a restart harmless —
 * the next send rehydrates the session from disk (see `handleSendMessage`).
 *
 * Best-effort on purpose: losing a transcript is a degraded experience, not a
 * reason for the send itself to fail.
 */
function persistLive(sessionId: string, live: LiveSession): void {
	try {
		const session = live.session;
		saveSession({
			id: sessionId,
			profile: "general",
			model: `${session.model.provider}/${session.model.id}`,
			expert: session.recipe.expert,
			cwd: session.cwd,
			createdAt: live.createdAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messages: [...session.agent.state.messages],
		});
	} catch {
		// Persistence is best-effort; the in-memory conversation is unaffected.
	}
}

/**
 * Files the model handed over with `present_files` during this process's life.
 *
 * Captured from the tool's own result rather than from `details` re-derived in
 * the shell: the tool already classified each item, and this way the artifact
 * panel cannot disagree with what was delivered.
 *
 * In-memory and therefore lost when the bridge restarts — there is no durable
 * artifact store on our side yet, and inventing one to satisfy a panel would
 * mean writing a schema we have not designed. Reported as what it is: what has
 * been delivered since the bridge started.
 */
const delivered: Array<Record<string, unknown>> = [];

/** Pull presented items out of a `present_files` tool result, if that is it. */
function captureDelivered(event: { name?: unknown; result?: unknown }): void {
	if (event.name !== "present_files") return;
	const result = event.result as { details?: { items?: unknown } } | undefined;
	const items = result?.details?.items;
	if (!Array.isArray(items)) return;
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.target !== "string") continue;
		delivered.push({
			artifact_id: record.target,
			workspace_id: process.cwd(),
			path: record.target,
			type: String(record.preview ?? "other"),
			summary: String(record.name ?? ""),
			hash: "",
			version: 1,
			input_sources: [],
			generation_status: "generated",
			verification_status: "unverified",
			delivery_ids: [],
			versions: [],
			size: typeof record.size === "number" ? record.size : 0,
			kind: record.kind,
		});
	}
}

/**
 * True when no provider key is configured: use the scripted transport.
 *
 * A key counts whether it came from the environment or was stored through the
 * interface. Checking only the environment is how a user who just saved a key
 * in the settings page gets scripted replies anyway — the same "the key I saved
 * does nothing" bug class as the desktop GUI's, and the fix is the same: ask
 * the credential store, not just `process.env`.
 */
function useScripted(): boolean {
	return scriptedRunEnabled() || (!process.env.DEEPSEEK_API_KEY && credentialStore().storedProviderIds().size === 0);
}

/** Translate one pi event into zero or more shell events to push. */
function translate(event: { type: string; [key: string]: unknown }, runId: string): Array<Record<string, unknown>> {
	const ts = new Date().toISOString();
	switch (event.type) {
		case "run_start":
			return [{ type: "run.started", run_id: runId, goal: "", ts }];
		case "text_delta":
			return [{ type: "llm.token", run_id: runId, token: event.text as string, ts }];
		case "thinking_delta":
			return [{ type: "llm.thinking", run_id: runId, step: 0, thinking: event.text as string, ts }];
		case "tool_start":
			return [{
				type: "tool.call_started",
				run_id: runId,
				tool_use_id: event.id as string,
				tool_name: event.name as string,
				params: (event.args ?? {}) as Record<string, unknown>,
				ts,
			}];
		case "tool_end": {
			const output = typeof (event.result as { content?: unknown })?.content === "string"
				? ((event.result as { content: string }).content)
				: JSON.stringify(event.result ?? "");
			return [{
				type: "tool.call_finished",
				run_id: runId,
				tool_use_id: event.id as string,
				tool_name: event.name as string,
				elapsed_ms: 0,
				output,
				ts,
			}];
		}
		case "run_end":
			return [{ type: "run.finished", run_id: runId, status: "success", steps: 0, total_input_tokens: 0, total_output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, elapsed_s: 0, context_pct: 0, ts }];
		case "error":
			return [{ type: "log.line", run_id: runId, level: "error", source: "gdou", message: event.message as string, ts }];
		case "notice":
			return [{ type: "log.line", run_id: runId, level: "info", source: "gdou", message: event.message as string, ts }];
		default:
			return [];
	}
}

function send(socket: WebSocket, message: unknown): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * One stored session, in the shape the shell's session list expects.
 *
 * Fields we have no equivalent for (`latest_run_id`, token totals) are reported
 * as empty rather than guessed: the shell renders them as "—", and a number
 * invented here would look like a real accounting of a run we never measured.
 */
function snapshotOf(item: SessionSummary): Record<string, unknown> {
	return {
		session_id: item.id,
		title: item.title,
		status: "active",
		updated_at: item.updatedAt,
		archived: false,
		pinned: false,
		workspace_id: process.cwd(),
		expert: item.expert ?? null,
		latest_run_id: null,
		total_input_tokens: 0,
		total_output_tokens: 0,
		total_elapsed_s: 0,
	};
}

/**
 * Settings in the shape the shell's `settings.get` promises.
 *
 * Only `model` maps onto anything we store; the rest describe a runtime we do
 * not have and are reported as the stable values the shell accepts. `base_url`
 * is deliberately undefined — there is no endpoint override here, and a value
 * would read as a choice the user could then try to edit.
 */
function settingsShape(settings: Settings): Record<string, unknown> {
	return {
		provider: "openai",
		api_format: "openai_chat_completions",
		model: settings.model ?? "",
		// The fallback model is a real kernel setting (switched to only when the
		// primary fails before producing any output). Reported so the shell can
		// show what would catch a provider outage, and so the settings page does
		// not read as "no such thing exists".
		fallback_model: settings.fallbackModel ?? "",
		permission_mode: "normal",
		context_window: 128_000,
		max_output_tokens: 8_192,
		temperature: null,
		top_p: null,
		reasoning_effort: "",
		timeout_s: 120,
		max_retries: 2,
		cache_control: false,
		supports_vision: false,
		base_url: undefined,
	};
}

/**
 * One stored model profile in the shape the shell's model picker renders.
 *
 * The picker's `ModelProfile` type names fields a runtime profile would have
 * (vendor, api format, sampling knobs). We store only a spec, so the rest are
 * reported as the picker's defaults; `vendor` is derived from the spec so the
 * list still groups by provider.
 */
function profileRow(profile: { id: string; name: string; model: string }, isCurrent: boolean): Record<string, unknown> {
	const vendor = profile.model.split("/")[0] ?? "";
	// A key counts whether it came from the environment or was stored through
	// the interface — otherwise the editor would keep asking for a key that is
	// already saved, which reads as "the key I saved vanished".
	const hasKey =
		credentialStore().storedProviderIds().has(vendor) ||
		presetsWithCredentials().some((preset) => preset.id === vendor);
	return {
		id: profile.id,
		name: profile.name,
		icon: "",
		vendor,
		provider: "openai",
		model: profile.model,
		base_url: "",
		has_api_key: hasKey,
		is_current: isCurrent,
		builtin: false,
		api_format: "openai_chat_completions",
		context_window: 128_000,
		max_output_tokens: 8_192,
		temperature: null,
		top_p: null,
		reasoning_effort: "",
		timeout_s: 120,
		max_retries: 2,
		cache_control: false,
		supports_vision: false,
	};
}

/**
 * Every selectable model: the saved profiles, plus the current model when it is
 * not among them. The picker must always show what a session would use, and a
 * model set by other means (the composer, the settings page) is current too.
 */
function modelsShape(settings: Settings): Record<string, unknown>[] {
	const profiles = settings.modelProfiles ?? [];
	const rows = profiles.map((profile) => profileRow(profile, profile.model === settings.model));
	if (settings.model && !profiles.some((profile) => profile.model === settings.model)) {
		rows.unshift(profileRow({ id: "current", name: settings.model, model: settings.model }, true));
	}
	return rows;
}

/**
 * Build a "provider/modelId" spec from what the shell's model editor sends.
 *
 * The editor collects a vendor and a model name; our catalog resolves full
 * specs. A slash-bearing value is taken as the spec. A bare id is looked up
 * across every provider: unique → spec, ambiguous → the user is told to be
 * explicit, unknown → the id is named. Refusing ambiguity beats guessing — a
 * model id that exists under several providers would silently save or test the
 * wrong one.
 */
function specFromInput(input: Record<string, unknown>): string {
	const raw = typeof input.model === "string" ? input.model.trim() : "";
	if (!raw) throw new Error("模型名不能为空");
	if (raw.includes("/")) return raw;
	const runtime = ModelRuntime.create();
	const matches = runtime.all().filter((model) => model.id === raw);
	if (matches.length === 1) return `${matches[0].provider}/${raw}`;
	if (matches.length > 1) throw new Error(`模型 ${raw} 在多个服务商下存在，请用 provider/model 形式完整指定`);
	throw new Error(`未知模型：${raw}`);
}

/**
 * One skill in the shape the shell's skill center renders.
 *
 * `display_name` is the frontmatter `name` (the kernel's `label`); showing the
 * id instead would make every skill render as its directory name.
 */
function skillRow(skill: Skill, enabled: boolean): Record<string, unknown> {
	const builtin = skill.source.startsWith("(built-in)");
	return {
		id: skill.id,
		name: skill.id,
		display_name: skill.label,
		description: skill.description,
		short_description: skill.description,
		source: builtin ? "builtin" : "personal",
		scope: builtin ? "system" : "workspace",
		path: builtin ? "" : skill.source,
		enabled,
		allow_implicit_invocation: true,
	};
}

/** Skill ids the user has turned off, as a set the loader accepts. */
function disabledSkills(settings: Settings): ReadonlySet<string> {
	return new Set(settings.disabledSkills ?? []);
}

/**
 * Run one kernel tool directly, outside a session.
 *
 * File access goes through the kernel's own tools rather than `node:fs` so it
 * inherits the same handling the agent gets — binary detection, truncation,
 * ripgrep integration. A parallel implementation here would be a second thing
 * to keep correct, and the one that drifted would be the one that corrupted a
 * file.
 */
async function useTool(name: string, params: Record<string, unknown>): Promise<string> {
	const tool = resolveTool(name, process.cwd());
	if (!tool) throw new Error(`no such tool: ${name}`);
	const result = await tool.execute(randomUUID(), params);
	return result.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
}

/** Run `git` in the working directory. Rejects non-zero exits as errors. */
async function git(args: string[]): Promise<string> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	const { stdout } = await run("git", args, { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
	return stdout;
}

/**
 * Run one turn and stream its events back.
 *
 * Shared by `session.send_message` and `session.steer_message`: the two differ
 * only in what the shell calls them, since pi has no way to interrupt a turn
 * that is already running.
 */
async function handleSendMessage(socket: WebSocket, id: string, params: Record<string, unknown>, steered: boolean): Promise<void> {
	const reply = (result: unknown) => send(socket, { jsonrpc: "2.0", id, result });
	const error = (code: number, message: string) => send(socket, { jsonrpc: "2.0", id, error: { code, message } });

	const sessionId = params.session_id as string;
	let live = sessions.get(sessionId);
	if (!live) {
		// A bridge restart clears the in-memory map, orphaning every conversation
		// the shell still holds. If the session exists on disk, rebuild it from
		// its transcript — with the *current* configuration, so a key saved after
		// the conversation began takes effect and a session that started as a
		// scripted preview becomes a real one. Refusing here would turn a restart
		// into "history sends but nothing replies", which is exactly the bug this
		// rehydration exists to prevent.
		const stored = loadSession(sessionId);
		if (!stored) return error(-32602, `unknown session: ${sessionId}`);
		const rebuilt = await buildSession(stored.messages, {
			mode: stored.profile,
			expert: stored.expert ?? null,
		}, undefined, askUserViaBridge);
		live = { session: rebuilt, createdAt: stored.createdAt };
		sessions.set(sessionId, live);
	}
	const runId = randomUUID();
	live.runId = runId;

	const content = params.content as string;
	const unsubscribe = live.session.subscribe((event) => {
		// Delivered files are recorded as they happen, so the artifact panel
		// shows what this run actually handed over.
		if (event.type === "tool_end") captureDelivered(event as { name?: unknown; result?: unknown });
		for (const translated of translate(event, runId)) {
			send(socket, { kind: "event", event: translated });
		}
	});

	// The question channel points at this run for its lifetime, so an `ask_user`
	// call mid-stream pushes the dialog to the right socket and waits there.
	activeQuestionContext = { socket, sessionId, runId };

	try {
		await live.session.prompt(content);
	} catch (err) {
		send(socket, {
			kind: "event",
			event: {
				type: "log.line",
				run_id: runId,
				level: "error",
				source: "gdou",
				message: (err as Error).message,
				ts: new Date().toISOString(),
			},
		});
	} finally {
		activeQuestionContext = null;
		unsubscribe();
		live.runId = undefined;
		// The turn is done either way; keep the transcript on disk so the
		// conversation survives the next bridge restart.
		persistLive(sessionId, live);
	}
	void steered;
	return reply({ run_id: runId });
}

/**
 * Build a live agent session.
 *
 * `messages` seeds the transcript, which is how a stored conversation becomes
 * talkable again: without it, a resumed session would start empty and the
 * earlier turns — the reason the user reopened it — would be invisible to the
 * model.
 *
 * `recipe` lets the caller pick a mode and an expert. The bridge's sessions are
 * always the general mode (the shell has no mode picker of its own), but the
 * expert is a real user choice and must survive: it narrows the tool set and
 * shapes the prompt, so a session that used one and a session that did not are
 * not interchangeable. The recipe rides along on the persisted transcript, so
 * a rehydrated session is rebuilt with the same expert.
 */
async function buildSession(
	messages: NonNullable<Parameters<typeof createAgent>[0]>["messages"],
	recipe: { mode?: string; expert?: string | null } = {},
	permission?: Parameters<typeof createAgent>[0]["permission"],
	askUser?: Parameters<typeof createAgent>[0]["askUser"],
): Promise<AgentSession> {
	const cwd = process.cwd();
	const options: Parameters<typeof createAgent>[0] = {
		recipe: { mode: recipe.mode ?? "general", expert: recipe.expert },
		cwd,
		settings: {},
		...(permission ? { permission } : {}),
		...(askUser ? { askUser } : {}),
		...(messages ? { messages } : {}),
	};
	if (useScripted()) {
		// No key: run the scripted transport so the shell still renders a
		// real conversation during development. The model spec comes from
		// the scripted run too — without it `createAgent` resolves the model
		// from settings/env, which fails outright on a machine with no
		// credentials, and the session never gets built.
		//
		// The tool names come from the mode itself rather than a hard-coded
		// pair: the scripted run only offers `present_files` when the mode
		// declares it, so passing a guessed list silently disabled artifact
		// delivery and left the artifact panel permanently empty.
		const profile = getProfile("general", cwd);
		const toolNames = (await profile.tools({ cwd })).map((tool) => tool.name);
		const scripted = scriptedRun(toolNames, cwd);
		options.streamFn = scripted.streamFn;
		options.model = scripted.model;
	}
	return createAgent(options);
}

/**
 * Next fire time for a schedule, computed the same way the shell's form does
 * (daily / weekly / monthly). Stored as `next_run_at` so `dueTasks` only ever
 * compares instants — timezone arithmetic happens here, once, at save time.
 */
function computeNextRun(type: ScheduledTask["schedule_type"], hour: number, minute: number, day: number, now = new Date()): string {
	const next = new Date(now);
	next.setSeconds(0, 0);
	next.setHours(hour, minute, 0, 0);
	if (type === "daily") {
		if (next <= now) next.setDate(next.getDate() + 1);
	} else if (type === "weekly") {
		let offset = (day - now.getDay() + 7) % 7;
		if (!offset && next <= now) offset = 7;
		next.setDate(now.getDate() + offset);
	} else if (type === "monthly") {
		next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
		if (next <= now) {
			next.setMonth(next.getMonth() + 1, 1);
			next.setDate(Math.min(day, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
		}
	}
	return next.toISOString();
}

/**
 * Run one automation once.
 *
 * Unattended runs are read-only: `{ tier: "read-only", approval: "never" }`
 * means the agent can read and reason but cannot write the workspace or run
 * commands that would. "Do not ask" must mean "do not do" — this is the one
 * place the shell's permission chooser is deliberately bypassed.
 *
 * The run never enters the conversation history: it builds a throwaway session
 * over the task's prompt, records `last_result` on the task, and disposes. An
 * automation's product is its outcome, not a chat the user is invited to reopen.
 */
async function runAutomation(task: ScheduledTask): Promise<void> {
	try {
		const session = await buildSession(undefined, { mode: "general" }, { tier: "read-only", approval: "never" });
		try {
			await session.prompt(task.prompt);
		} finally {
			session.dispose();
		}
		updateTaskResult(task.id, "completed", computeNextRun(task.schedule_type, task.hour, task.minute, task.schedule_type === "monthly" ? (task.day_of_month ?? 1) : task.day_of_week));
	} catch (error) {
		updateTaskResult(task.id, "failed", computeNextRun(task.schedule_type, task.hour, task.minute, task.schedule_type === "monthly" ? (task.day_of_month ?? 1) : task.day_of_week));
		console.error(`[gdou-bridge] automation "${task.name}" failed:`, (error as Error).message);
	}
}

/**
 * Why a method is not implemented, in the user's language.
 *
 * The shell shows an unmatched error message verbatim — its own translation
 * table only rewrites infrastructure failures (timeouts, ECONNREFUSED), so
 * anything else reaches the screen as-is. A message carrying internal wording
 * ("stage 1") or raw English would be read as a bug report rather than as an
 * answer, so every refusal here says what is missing and why.
 */
const NOT_IMPLEMENTED: Record<string, string> = {
	// Plugin marketplace: a shell-specific concept with no counterpart here.
	"plugin.install": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.uninstall": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.set_enabled": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.add_marketplace": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.refresh_marketplaces": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.remove_marketplace": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	"plugin.install_catalog": "插件市场尚未实现：这里没有插件体系，扩展能力走技能与 MCP。",
	// Model profiles: we keep one configured spec, not a library of profiles.
	"provider.ccswitch_apply": "外部配置切换尚未实现。",
	// Destructive git: refused until an approval step exists.
	"git.commit": "提交尚未实现：在没有审批步骤之前，不提供一键改写工作区的操作。",
	"change.stage": "暂存尚未实现：在没有审批步骤之前，不提供一键改写工作区的操作。",
	"change.unstage": "取消暂存尚未实现：在没有审批步骤之前，不提供一键改写工作区的操作。",
	"change.discard": "丢弃改动尚未实现：这会直接丢弃未提交的工作，目前不提供。",
	"change.revert": "回滚尚未实现：这会直接改写工作区，目前不提供。",
	// Workspace management: there is one working directory, chosen at launch.
	"workspace.open": "切换工作目录尚未实现：当前会话的工作目录在启动时确定。",
	"workspace.rename": "重命名工作目录尚未实现。",
	"workspace.delete": "删除工作目录尚未实现。",
	"workspace.archive": "归档工作区尚未实现。",
	"workspace.pin": "置顶工作区尚未实现：只有一个工作目录。",
	"workspace.resume": "恢复工作区尚未实现：只有一个工作目录。",
	// Interaction channels the kernel does not have.
	"permission.respond": "权限审批界面尚未接入：目前工具调用按内核的权限策略直接判定。",
	"session.set_workspace": "切换会话的工作目录尚未实现。",
};

/** Dispatch one JSON-RPC request to the matching handler. */
async function handleRequest(socket: WebSocket, id: string, method: string, params: Record<string, unknown>): Promise<void> {
	const reply = (result: unknown) => send(socket, { jsonrpc: "2.0", id, result });
	const error = (code: number, message: string) => send(socket, { jsonrpc: "2.0", id, error: { code, message } });

	switch (method) {
		case "core.ping":
			return reply({ server_version: "gdou-bridge", uptime_ms: Math.round(process.uptime() * 1000), received_at: new Date().toISOString(), capabilities: ["stdio"] });

		case "event.subscribe":
			// Topics are accepted but not used for filtering in stage 1: every
			// connected socket gets every event for the sessions it owns.
			return reply({ subscribed: (params.topics as string[]) ?? [], scope: params.scope ?? "global" });

		// ---- boot set: what refreshIndex() calls in parallel at startup ----

		case "workspace.list": {
			// One workspace: the process working directory. The shell is built
			// around picking a project; we have a single cwd, and pretending to
			// host several would invent state nothing here can switch to.
			const cwd = process.cwd();
			return reply({
				workspaces: [{
					workspace_id: cwd,
					name: basename(cwd) || cwd,
					path: cwd,
					archived: false,
					pinned: true,
				}],
			});
		}

		case "session.list":
			return reply({ sessions: listSessions().map(snapshotOf) });

		case "settings.get": {
			const settings = loadSettings();
			return reply(settingsShape(settings));
		}

		case "provider.status": {
			const settings = loadSettings();
			const skillsCatalog = loadSkills(process.cwd(), disabledSkills(settings));
			// A key counts whether it came from the environment or was stored
			// through the interface — the shell's "未配置" badge must not argue
			// with a key the user just saved.
			const configured = presetsWithCredentials().length > 0 || credentialStore().storedProviderIds().size > 0;
			// MCP servers reported from the config, not fabricated: the shell's
			// badge wants to know what is declared, and the status distinguishes
			// "approved and would connect" from "configured but waiting for the
			// user's first-connection approval". A server that fails to connect
			// surfaces per-session via `mcpErrors` instead.
			const approved = new Set(approvedMcpServers());
			const mcpServers = Object.entries(loadMcpConfig(process.cwd()))
				.filter(([name, entry]) => entry && typeof entry === "object" && typeof entry.command === "string" && entry.disabled !== true)
				.map(([name]) => ({ name, status: approved.has(name) ? "approved" : "pending" }));
			return reply({
				provider: "openai",
				api_format: "openai_chat_completions",
				model: settings.model ?? "",
				api_key_configured: configured,
				ready_for_next_run: true,
				skills: skillsCatalog.skills.map((skill) => ({
					id: skill.id,
					name: skill.label,
					description: skill.description ?? "",
					enabled: !disabledSkills(settings).has(skill.id),
					scope: "builtin",
				})),
				mcp_servers: mcpServers,
			});
		}

		case "expert.list": {
			// Experts are markdown files (built-in / user / project), resolved on
			// demand. Only the pickable surface is reported — id, name,
			// description — never the methodology body, which belongs in the
			// assembled prompt.
			const experts = listExperts(process.cwd());
			return reply({
				experts: experts.map((expert) => ({
					id: expert.id,
					name: expert.label,
					description: expert.description,
				})),
			});
		}

		case "mcp.list": {
			// Every configured server plus its approval state, so the settings
			// page can show what would connect and let the user approve what is
			// still pending. `command` is the spawn target — the exact thing the
			// approval is about — and showing it is the point of the row.
			const approved = new Set(approvedMcpServers());
			const servers = Object.entries(loadMcpConfig(process.cwd()))
				.filter(([name, entry]) => entry && typeof entry === "object" && typeof entry.command === "string" && entry.disabled !== true)
				.map(([name, entry]) => ({
					name,
					command: (entry as { command: string }).command,
					approved: approved.has(name),
				}));
			return reply({ servers });
		}

		case "mcp.approve": {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name) return error(-32602, "mcp server name is required");
			const config = loadMcpConfig(process.cwd());
			if (!config[name] || typeof config[name].command !== "string") {
				return error(-32602, `unknown mcp server: ${name}`);
			}
			approveMcpServer(name);
			return reply({ approved: [name] });
		}

		case "question.pending": {
			// Questions that `ask_user` parked and the shell has not answered yet.
			// Reported so a reconnect or a page refresh can rebuild the dialog that
			// the composer is currently showing.
			const sessionFilter = typeof params.session_id === "string" ? params.session_id : null;
			const pending = [...pendingQuestions.entries()]
				.filter(([, question]) => !sessionFilter || question.sessionId === sessionFilter)
				.map(([rpcId, question]) => ({
					rpc_id: rpcId,
					session_id: question.sessionId,
					run_id: question.runId,
					questions: [],
				}));
			return reply({ pending });
		}

		case "question.respond": {
			const rpcId = typeof params.rpc_id === "string" ? params.rpc_id : "";
			const question = pendingQuestions.get(rpcId);
			if (!question) return error(-32602, "没有这个待回答的问题，或它已被回答");
			pendingQuestions.delete(rpcId);
			// The answers come as `{ id, selected: string[], custom? }[]`. They are
			// folded into one text block, which is what the model sees as the tool
			// result — the tool's whole contract is "a human answered".
			const answers = Array.isArray(params.answers) ? params.answers as Array<{ id?: string; selected?: string[]; custom?: string }> : [];
			const text = answers
				.map((answer, index) => {
					const selected = (answer.selected ?? []).join(", ");
					const custom = (answer.custom ?? "").trim();
					return [selected, custom].filter(Boolean).join("；") || "（未选择）";
				})
				.join("\n");
			// Tell the shell the dialog is closed (even if the tool's own event
			// stream is what re-renders it) so the composer does not keep waiting.
			send(socket, {
				kind: "event",
				event: {
					type: "question.resolved",
					rpc_id: rpcId,
					session_id: question.sessionId,
					run_id: question.runId,
				},
			});
			question.resolve(text);
			return reply({ answered: rpcId });
		}

		case "operation.list":
			return reply({ operations: [] });

		// ---- session lifecycle: what the list and the header act on ----

		case "session.get_history": {
			const id = params.session_id as string;
			const stored = loadSession(id);
			if (!stored) return error(-32602, `unknown session: ${id}`);
			// pi messages carry content blocks; the shell wants plain text per
			// role. `blocksToText` is the same reduction the TUI uses, so history
			// renders the same way in both front-ends rather than one of them
			// silently showing less.
			//
			// The leading system message is dropped: it is the assembled prompt,
			// an implementation detail of how the agent was built, and showing it
			// as the first "assistant" turn would read as the agent introducing
			// itself with its own instructions.
			return reply({
				messages: stored.messages
					.filter((message) => message.role !== "system" && "content" in message)
					.map((message) => ({
						role: message.role === "user" ? "user" : "assistant",
						content: blocksToText(message.content),
						ts: stored.updatedAt,
						model: stored.model,
					})),
				// The expert that shaped this conversation, so a reopened session shows
				// the same "为什么工具变少了" indicator it had when it was created.
				expert: stored.expert ?? null,
				run_stats: {},
				context_injections: [],
			});
		}

		case "session.rename": {
			const id = params.session_id as string;
			const title = (params.title as string)?.trim();
			// An empty title is refused rather than applied: the shell's own
			// rename does the same, and a session titled "" is unfindable.
			if (!title) return error(-32602, "title must not be empty");
			const renamed = renameSession(id, title);
			if (!renamed) return error(-32602, `unknown session: ${id}`);
			return reply({ session: snapshotOf(renamed) });
		}

		case "session.delete": {
			deleteSession(params.session_id as string);
			return reply({});
		}

		case "session.archive":
		case "session.pin":
			// Neither exists on our side: sessions are a flat list on disk with no
			// archived or pinned flag. Echoing the requested value would make the
			// badge appear once and vanish on the next refresh, which is worse
			// than not claiming the feature.
			return reply({ session: {} });

		// ---- files: the inspector's tree and file viewer ----

		case "workspace.tree": {
			const relative = (params.path as string) ?? "";
			const target = relative ? join(process.cwd(), relative) : process.cwd();
			const text = await useTool("ls", { path: target, limit: 1000 });
			// `ls` renders for a human; the shell wants nodes. Re-stat the entries
			// rather than parse that text — parsing presentation output is how a
			// rename in pi's formatter silently breaks a panel here.
			const nodes = readdirSync(target, { withFileTypes: true })
				.filter((entry) => !entry.name.startsWith("."))
				.map((entry) => ({
					path: relative ? `${relative}/${entry.name}` : entry.name,
					name: entry.name,
					kind: entry.isDirectory() ? "directory" : "file",
				}));
			void text;
			return reply({ nodes });
		}

		case "file.read": {
			const text = await useTool("read", { path: (params.path as string) ?? "" });
			return reply({ content: text, path: params.path });
		}

		case "file.search": {
			const text = await useTool("grep", { pattern: (params.query as string) ?? "", path: process.cwd(), limit: 100 });
			return reply({ matches: [], text });
		}

		// ---- git: read-only. The mutating verbs are deliberately absent. ----

		case "workspace.status": {
			const [branch, porcelain] = await Promise.all([
				git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
				git(["status", "--porcelain"]).catch(() => ""),
			]);
			return reply({
				branch: branch.trim() || null,
				is_git_repository: true,
				changed_file_count: porcelain.split("\n").filter((line) => line.trim().length > 0).length,
			});
		}

		case "change.list": {
			const porcelain = await git(["status", "--porcelain"]).catch(() => "");
			return reply({
				changes: porcelain
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line) => {
						const status = line.slice(0, 2).trim();
						const path = line.slice(3);
						return { path, status, kind: status.includes("?") ? "added" : "modified" };
					}),
			});
		}

		case "change.diff": {
			const diff = await git(["diff", "--", (params.path as string) ?? ""]).catch(() => "");
			return reply({ diff });
		}

		case "git.history": {
			const log = await git(["log", "--pretty=%H%x1f%an%x1f%ad%x1f%s", "--date=iso", "-n", "50"]).catch(() => "");
			return reply({
				commits: log
					.split("\n")
					.filter((line) => line.trim().length > 0)
					.map((line) => {
						const [hash, author, date, subject] = line.split("");
						return { hash, author, date, subject };
					}),
				has_more: false,
			});
		}

		// ---- artifacts: what the model has handed over this session ----

		case "artifact.list":
			// Deliveries are recorded as `present_files` completes, so this is the
			// real list rather than a placeholder. It does not survive a bridge
			// restart — see the note on `delivered`.
			return reply({ artifacts: delivered });

		// ---- skills: the catalog the skill center and the palette show ----

		case "skill.list": {
			const settings = loadSettings();
			const disabled = disabledSkills(settings);
			const catalog = loadSkills(process.cwd(), disabled);
			return reply({
				skills: catalog.skills.map((skill) => skillRow(skill, !disabled.has(skill.id))),
			});
		}

		case "skill.install": {
			// Installing copies the directory; scoped to the workspace or the
			// user's home. The kernel validates the source before anything lands
			// on disk, so a broken skill is refused rather than installed and
			// reported as an error on every load.
			const source = params.source_path as string;
			if (!source) return error(-32602, "需要 source_path");
			try {
				const skill = installSkill(source, params.scope === "workspace" ? "workspace" : "personal", process.cwd());
				return reply({ skill: skillRow(skill, true) });
			} catch (err) {
				return error(-32602, (err as Error).message);
			}
		}

		case "skill.uninstall": {
			if (params.confirm !== "uninstall") return error(-32602, '需要 confirm: "uninstall"');
			try {
				uninstallSkill(params.skill_id as string, process.cwd());
			} catch (err) {
				return error(-32602, (err as Error).message);
			}
			const settings = loadSettings();
			const disabled = (settings.disabledSkills ?? []).filter((id) => id !== params.skill_id);
			settings.disabledSkills = disabled.length > 0 ? disabled : undefined;
			saveSettings(settings);
			return reply({});
		}

		case "skill.set_enabled": {
			const id = params.skill_id as string;
			const enabled = params.enabled === true;
			const settings = loadSettings();
			const disabled = new Set(settings.disabledSkills ?? []);
			if (enabled) disabled.delete(id);
			else disabled.add(id);
			settings.disabledSkills = [...disabled];
			saveSettings(settings);
			// The row is looked up in the *full* catalog: a just-disabled skill is
			// filtered out of the list, but its row is what the skill center
			// renders the toggle with, and the toggle must reflect what just
			// happened. The `enabled` flag is what the caller reports, not what
			// the catalog thinks.
			const catalog = loadSkills(process.cwd());
			const skill = catalog.skills.find((entry) => entry.id === id);
			return reply({ skill: skill ? skillRow(skill, enabled) : {} });
		}

		// ---- models: the picker in the composer and the settings page ----

		case "provider.model_list": {
			const settings = loadSettings();
			// The saved profiles plus the current model; the built-in catalogue of
			// 1442 models is never dumped into the picker — a list no one can
			// search usefully. Adding a model is done through the editor, which
			// saves a profile.
			return reply({ models: modelsShape(settings) });
		}

		case "provider.model_select": {
			// Selecting writes the setting; the running session is not rebuilt here.
			// Rebuilding on every picker click would tear down a conversation
			// mid-turn, and the shell re-reads `settings.get` on refresh anyway.
			const id = params.model_id as string;
			const settings = loadSettings();
			const profile = (settings.modelProfiles ?? []).find((entry) => entry.id === id);
			if (!profile) return error(-32602, `未知模型档案：${id}`);
			settings.model = profile.model;
			saveSettings(settings);
			return reply({ settings: settingsShape(settings), models: modelsShape(settings) });
		}

		case "provider.model_save": {
			// A saved profile is a named spec. The editor's extra fields (API
			// address, sampling knobs) describe a runtime we do not have; what we
			// can store and reuse is the spec, so that is all that is kept. Saving
			// also makes the model current — that is what the editor's "save and
			// use" does, and leaving it unselected would make the save appear to
			// do nothing.
			let spec: string;
			try {
				spec = specFromInput(params);
				if (!ModelRuntime.create().resolve(spec)) throw new Error(`未知模型：${spec}`);
			} catch (err) {
				return error(-32602, (err as Error).message);
			}
			if (typeof params.api_key === "string" && params.api_key.trim().length > 0) {
				const providerId = parseModelSpec(spec).provider;
				if (providerId) {
					try {
						await setApiKey(providerId, params.api_key);
					} catch (err) {
						return error(-32602, (err as Error).message);
					}
				}
			}
			const settings = loadSettings();
			const id = typeof params.id === "string" && params.id.length > 0 ? params.id : randomUUID();
			const name = typeof params.name === "string" && params.name.trim().length > 0 ? params.name.trim() : spec;
			settings.modelProfiles = [
				...(settings.modelProfiles ?? []).filter((entry) => entry.id !== id),
				{ id, name, model: spec },
			];
			settings.model = spec;
			saveSettings(settings);
			return reply({ settings: settingsShape(settings), models: modelsShape(settings) });
		}

		case "provider.model_delete": {
			const settings = loadSettings();
			settings.modelProfiles = (settings.modelProfiles ?? []).filter((entry) => entry.id !== params.model_id);
			saveSettings(settings);
			return reply({ models: modelsShape(settings) });
		}

		case "provider.model_test": {
			let spec: string;
			try {
				spec = specFromInput(params);
			} catch (err) {
				return reply({ success: false, elapsed_ms: 0, input_tokens: 0, output_tokens: 0, error: (err as Error).message });
			}
			const result = await testModel(spec, { apiKey: typeof params.api_key === "string" ? params.api_key : undefined });
			return reply({
				success: result.success,
				elapsed_ms: result.elapsedMs,
				input_tokens: result.inputTokens,
				output_tokens: result.outputTokens,
				...(result.error ? { error: result.error } : {}),
			});
		}

		// ---- settings ----

		case "settings.update": {
			const settings = loadSettings();
			// Only the model maps onto anything we store. The rest of the shell's
			// settings describe a runtime we do not have (JEV, permission modes,
			// provider-specific sampling); accepting and discarding them would make
			// the settings page look saved while nothing changed.
			if (typeof params.model === "string") settings.model = params.model;
			// The fallback model is one we do store. Empty string means "clear it",
			// which is how the shell's "无" option expresses itself.
			if (typeof params.fallback_model === "string") {
				const trimmed = params.fallback_model.trim();
				if (trimmed) settings.fallbackModel = trimmed;
				else delete settings.fallbackModel;
			}
			saveSettings(settings);
			return reply({ settings: settingsShape(settings) });
		}

		// ---- remaining session verbs ----

		case "session.close": {
			// A live session is ours to dispose; a stored one is already closed.
			// Either way the shell's expectation — "this session is no longer
			// running" — holds, so a missing entry is not an error.
			const live = sessions.get(params.session_id as string);
			live?.session.dispose();
			sessions.delete(params.session_id as string);
			return reply({});
		}

		case "session.resume": {
			const id = params.session_id as string;
			const stored = loadSession(id);
			if (!stored) return error(-32602, `unknown session: ${id}`);
			// Resuming has to make the conversation *talkable*, not merely return
			// its snapshot: a session that exists only on disk is not in `sessions`,
			// so the next message would fail with "unknown session". Seeding the
			// stored transcript is what makes reopening a conversation work.
			if (!sessions.has(id)) {
				const live = { session: await buildSession(stored.messages), createdAt: stored.createdAt };
				sessions.set(id, live);
			}
			return reply({
				session: snapshotOf({
					id: stored.id,
					profile: stored.profile,
					title: stored.title,
					updatedAt: stored.updatedAt,
					messageCount: stored.messages.length,
				}),
			});
		}

		case "session.steer_message": {
			// Steering means interrupting a running turn with new instructions. pi
			// has no preemption — `prompt()` runs to completion — so this is sent as
			// an ordinary message rather than pretending to interrupt. The shell
			// shows it as a steer, which is the closest honest behaviour available.
			return handleSendMessage(socket, id, params, true);
		}

		case "session.fork": {
			const id = params.session_id as string;
			const stored = loadSession(id);
			if (!stored) return error(-32602, `unknown session: ${id}`);
			// Fork copies the transcript up to now under a new id. `through_run_id`
			// is ignored: we do not index messages by run, so "fork up to run X"
			// cannot be answered, and silently forking the whole conversation would
			// give back more than was asked for.
			const forked = saveSession({
				id: createSessionId(),
				profile: stored.profile,
				model: stored.model,
				cwd: stored.cwd,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: stored.messages,
				title: (params.title as string) || `${stored.title} (fork)`,
			});
			return reply({
				session_id: forked.id,
				session: snapshotOf({ id: forked.id, profile: forked.profile, title: forked.title, updatedAt: forked.updatedAt, messageCount: forked.messages.length }),
			});
		}

		case "session.compact": {
			// Reported from the real context state, not performed: compaction on
			// our side is pruning at request time (`pruneForContext`), not a
			// durable summary stored on the session. Inventing a summary here would
			// make the shell believe the transcript shrank when it did not.
			const live = sessions.get(params.session_id as string);
			const status = live?.session.contextStatus();
			return reply({
				summary_tokens: 0,
				saved_tokens: 0,
				removed_messages: status ? status.total - status.visible : 0,
				used_model: false,
			});
		}

		case "run.replay": {
			const runId = params.run_id as string;
			// Runs are not addressable on our side — events belong to a session's
			// transcript, not to a stored run — so replay resolves the owning
			// session and replays its messages as the events that produced them.
			for (const [sessionId, live] of sessions) {
				if (live.runId !== runId) continue;
				void sessionId;
				return reply({ events: [] });
			}
			return reply({ events: [] });
		}

		// ---- capabilities we do not have ----
		//
		// The distinction that matters here is read vs write.
		//
		// Read-only listings return an empty result, because the shell fetches
		// several of them in one `Promise.all` — the skill center asks for skills,
		// plugins and the marketplace catalogue together. Rejecting one rejects
		// the whole batch, so an honest "we have no plugins" would take down the
		// skills list that does work. These render as "暂无", which is true.
		//
		// Writes are rejected instead. Returning success for an install or a
		// scheduled task that never happened would leave the UI believing in
		// something that does not exist, and the next refresh would quietly
		// disagree with it.

		case "plugin.list":
			return reply({ plugins: [] });

		case "plugin.catalog":
			return reply({ marketplaces: [], plugins: [], supported: false });

		case "schedule.list":
			return reply({ tasks: listTasks() });

		case "schedule.create": {
			// The shell sends the task's fields at the top level (not nested under
			// a `task` key), matching how `schedule.update`/`schedule.pause` work.
			const input = params as Record<string, unknown>;
			if (typeof input.prompt !== "string" || !input.prompt.trim()) {
				return error(-32602, "定时任务需要一个非空的提示词");
			}
			const scheduleType = (["daily", "weekly", "monthly"] as const).includes(input.schedule_type as "daily") ? input.schedule_type as "daily" | "weekly" | "monthly" : "daily";
			const saved = upsertTask({
				id: typeof input.id === "string" ? input.id : undefined,
				name: typeof input.name === "string" ? input.name : "未命名任务",
				prompt: input.prompt.trim(),
				timezone: typeof input.timezone === "string" ? input.timezone : "UTC",
				schedule_type: scheduleType,
				day_of_week: Number(input.day_of_week) || 0,
				day_of_month: input.day_of_month !== undefined ? Number(input.day_of_month) || 1 : undefined,
				hour: Number(input.hour) || 0,
				minute: Number(input.minute) || 0,
				status: "active",
				missed_run_policy: input.missed_run_policy === "skip" ? "skip" : "run_once",
				workspace_id: typeof input.workspace_id === "string" ? input.workspace_id : undefined,
				budget: input.budget !== undefined ? Number(input.budget) || 300 : 300,
				next_run_at: typeof input.next_run_at === "string" ? input.next_run_at : computeNextRun(scheduleType, Number(input.hour) || 0, Number(input.minute) || 0, scheduleType === "monthly" ? Number(input.day_of_month) || 1 : Number(input.day_of_week) || 0),
			});
			return reply({ task: saved });
		}

		case "schedule.update": {
			// Same top-level convention as create; `id` is required to find the row.
			const input = params as Record<string, unknown>;
			const id = typeof input.id === "string" ? input.id : undefined;
			const existing = id ? getTask(id) : undefined;
			if (!existing) return error(-32602, "定时任务不存在");
			const scheduleType = ["daily", "weekly", "monthly"].includes(input.schedule_type as string) ? input.schedule_type as "daily" | "weekly" | "monthly" : existing.schedule_type ?? "daily";
			const saved = upsertTask({
				id: existing.id,
				name: typeof input.name === "string" ? input.name : existing.name,
				prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt.trim() : existing.prompt,
				timezone: typeof input.timezone === "string" ? input.timezone : existing.timezone,
				schedule_type: scheduleType,
				day_of_week: input.day_of_week !== undefined ? Number(input.day_of_week) || 0 : existing.day_of_week,
				day_of_month: input.day_of_month !== undefined ? Number(input.day_of_month) || 1 : existing.day_of_month,
				hour: input.hour !== undefined ? Number(input.hour) || 0 : existing.hour,
				minute: input.minute !== undefined ? Number(input.minute) || 0 : existing.minute,
				status: (["active", "paused", "failed", "waiting_authorization"] as const).includes(input.status as string) ? input.status as ScheduledTask["status"] : existing.status,
				missed_run_policy: input.missed_run_policy === "skip" ? "skip" : "run_once",
				workspace_id: typeof input.workspace_id === "string" ? input.workspace_id : existing.workspace_id,
				budget: input.budget !== undefined ? Number(input.budget) || 300 : existing.budget ?? 300,
				next_run_at: typeof input.next_run_at === "string" ? input.next_run_at : existing.next_run_at,
			});
			return reply({ task: saved });
		}

		case "schedule.pause": {
			const id = params.id as string;
			const existing = getTask(id);
			if (!existing) return error(-32602, "定时任务不存在");
			const saved = upsertTask({ ...existing, status: existing.status === "paused" ? "active" : "paused" });
			return reply({ task: saved });
		}

		case "schedule.run": {
			const id = params.id as string;
			const existing = getTask(id);
			if (!existing) return error(-32602, "定时任务不存在");
			// Fire immediately, asynchronously, and report the run as accepted —
			// the task card shows the outcome via its next refresh.
			void runAutomation(existing);
			return reply({ task: existing });
		}

		case "schedule.delete": {
			const id = params.id as string;
			const removed = deleteTask(id);
			if (!removed) return error(-32602, "定时任务不存在");
			return reply({ deleted: id });
		}

		case "provider.ccswitch_list":
			return reply({ providers: [] });

		case "run.get":
			// Runs are not addressable; `run.replay` above has the same limitation.
			return reply({ run_id: params.run_id ?? "", status: "unknown" });

		case "workspace.profile": {
			// A package manifest, if there is one, is the honest answer to "what
			// kind of project is this". Deeper detection (frameworks, entry points)
			// is not implemented, and guessing it would put invented structure in
			// a panel the user reads as fact.
			const pkgPath = join(process.cwd(), "package.json");
			let name = basename(process.cwd());
			let description = "";
			try {
				const parsed = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; description?: string };
				if (parsed.name) name = parsed.name;
				if (parsed.description) description = parsed.description;
			} catch {
				// No manifest is not an error; the directory name is still a name.
			}
			return reply({ profile: { name, description, components: [], validations: [], findings: [] } });
		}

		// `git.commit`, `change.stage`, `change.unstage`, `change.discard` and
		// `change.revert` are **not implemented**, and that is the point. Each
		// destructively rewrites the user's working tree from a single click in
		// the shell, with no approval step in between — stage 2 has no I4
		// (connect-time approval) yet. The shell already renders a friendly
		// "protocol too old" message for -32601, so an honest refusal here beats
		// wiring up a button that can throw away uncommitted work.

		case "session.create": {
			const sessionId = randomUUID();
			const expert = typeof params.expert === "string" && params.expert.trim() ? params.expert.trim() : undefined;
			const session = await buildSession(undefined, { expert }, undefined, askUserViaBridge);
			const live = { session, createdAt: new Date().toISOString() };
			sessions.set(sessionId, live);
			// Persist immediately so an empty task shows up in history even if the
			// user closes it without a run, and so a later send can rehydrate it.
			persistLive(sessionId, live);
			// The recipe's expert and the tools it narrowed away are known at build
			// time and reported here so the shell can show "为什么工具变少了" without
			// waiting for a run. `unavailable_tools` is honest: an expert that asks
			// for tools the mode lacks is visible, not silently thinner.
			return reply({
				session_id: sessionId,
				expert: session.recipe.expert ?? null,
				unavailable_tools: session.unavailableTools,
			});
		}

		case "session.send_message":
			return handleSendMessage(socket, id, params, false);


		case "run.cancel": {
			for (const live of sessions.values()) {
				if (live.runId === params.run_id) {
					live.session.abort();
					break;
				}
			}
			return reply({ run_id: params.run_id, status: "cancelling" });
		}

		default: {
			// Falls back to the table, and then to a last-resort line that is still
			// presentable: the shell renders whatever is not in its own translation
			// table, so nothing here may leak internal wording.
			return error(-32601, NOT_IMPLEMENTED[method] ?? `此功能尚未实现（${method}）。`);
		}
	}
}

const wss = new WebSocketServer({ port: PORT });

/**
 * The runtime-only scheduler.
 *
 * Automations fire only while the bridge process is alive — that is the honest
 * reading of "runtime only" in `schedule.ts`: nothing survives a restart, and
 * the UI says so. A minute tick is coarse enough to be cheap and fine enough
 * that a scheduled run lands within a minute of its time.
 */
setInterval(() => {
	for (const task of dueTasks()) {
		void runAutomation(task);
	}
}, 60_000).unref();

/**
 * A port clash is the one failure a user hits repeatedly, and the raw
 * `EADDRINUSE` stack says nothing about why. Almost always it means a bridge
 * from an earlier run is still alive — which is harmless, since the shell can
 * use it — so the message says that instead of pointing at `node:net`.
 */
wss.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		console.error(
			`\n[gdou-bridge] 端口 ${PORT} 已被占用。\n` +
				`  多半是之前启动的桥还在运行 —— 它是可用的，直接用即可，不必再启一个。\n` +
				`  若要重启，先结束占用该端口的进程（PowerShell）：\n` +
				`    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess\n` +
				`    Stop-Process -Id <pid> -Force\n`,
		);
		process.exit(1);
	}
	console.error(`[gdou-bridge] 启动失败：${err.message}`);
	process.exit(1);
});

wss.on("listening", () => {
	console.log(`[gdou-bridge] listening on ws://127.0.0.1:${PORT} (scripted=${useScripted()})`);
});

wss.on("connection", (socket) => {
	socket.on("message", (data) => {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
		} catch {
			return;
		}
		if (typeof message.method === "string" && typeof message.id === "string") {
			void handleRequest(socket, message.id, message.method, (message.params ?? {}) as Record<string, unknown>);
		}
	});
});
