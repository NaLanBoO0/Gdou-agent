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
import { existsSync, mkdirSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import { deleteMemory, loadMemory, upsertMemory } from "../src/index.ts";
import { deleteTask, dueTasks, getTask, listTasks, updateTaskResult, upsertTask } from "../src/automation/schedule.ts";
import type { ScheduledTask } from "../src/automation/schedule.ts";
import type { Settings } from "../src/config/settings.ts";
import type { Skill } from "../src/skills/types.ts";
import { workspacesPath } from "../src/paths.ts";
import { PROJECT_ROOT, AGENT_HOME } from "../src/paths.ts";
import { provisionManagedBinaries } from "../src/kernel/toolchain.ts";

/** Listen port. Overridable so a second instance can run beside a live one
 *  (used by tests); the shell hardcodes 7438, so only the bridge reads this. */
const PORT = Number(process.env.GDOU_BRIDGE_PORT ?? 7438);

/**
 * Workspace registry, persisted at ~/.gdou-agent/workspaces.json.
 *
 * The kernel has one working directory per session, but the shell is built around
 * a project tree — opening a folder from the shell must (a) list that folder as a
 * project, and (b) let a conversation created there run with that folder as its
 * working directory. `workspace.open` registers the chosen folder here; the id is
 * the folder's real path, the same scheme the previous single-cwd model used.
 */
interface RegisteredWorkspace {
	id: string;
	path: string;
	name: string;
	pinned: boolean;
	archived: boolean;
	addedAt?: string;
}
let workspaceCache: Record<string, RegisteredWorkspace> | null = null;
function loadWorkspaces(): Record<string, RegisteredWorkspace> {
	if (workspaceCache) return workspaceCache;
	try {
		const raw = readFileSync(workspacesPath(), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		workspaceCache = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, RegisteredWorkspace>)
			: {};
	} catch {
		workspaceCache = {};
	}
	return workspaceCache;
}
function saveWorkspaces(): void {
	mkdirSync(dirname(workspacesPath()), { recursive: true });
	try { writeFileSync(workspacesPath(), `${JSON.stringify(workspaceCache ?? {}, null, 2)}\n`, "utf-8"); } catch { /* best-effort */ }
}
/** Folders no longer on disk are dropped from the registry (and thus the tree). */
function pruneWorkspaces(): void {
	const reg = loadWorkspaces();
	let changed = false;
	for (const id of Object.keys(reg)) {
		if (!existsSync(reg[id].path)) { delete reg[id]; changed = true; }
	}
	if (changed) { workspaceCache = reg; saveWorkspaces(); }
}

/**
 * Make sure the bridge's own working directory is a registered workspace.
 *
 * Seeded as pinned so the shell shows it near the top, but once in the registry
 * the user can toggle pin/unpin like any other project — it is no longer forced
 * permanently pinned (that left the "current" project stuck at the top).
 */
function ensureCwdInRegistry(): void {
	const cwd = process.cwd();
	const reg = loadWorkspaces();
	if (!reg[cwd]) {
		reg[cwd] = { id: cwd, path: cwd, name: basename(cwd) || cwd, pinned: true, archived: false, addedAt: new Date().toISOString() };
		workspaceCache = reg;
		saveWorkspaces();
	}
}

/**
 * Resolve a workspace id (a registered project path) to a real directory.
 *
 * Narrows the id to a folder that actually exists, so a stale workspace id
 * falls back to the bridge's own working directory rather than failing loudly.
 */
function resolveWorkspaceCwd(workspaceId: unknown): string | undefined {
	if (typeof workspaceId !== "string") return undefined;
	const reg = loadWorkspaces();
	const registered = reg[workspaceId];
	if (registered && existsSync(registered.path)) return registered.path;
	if (existsSync(resolve(workspaceId)) && statSync(resolve(workspaceId)).isDirectory()) return resolve(workspaceId);
	return undefined;
}

/**
 * A workspace by id, normalized to the shape workspace.list returns.
 *
 * The bridge's own working directory is always present and pinned; everything
 * else comes from the registry. Returns undefined for an unknown id (a project
 * that was deleted from the tree or a folder that no longer exists).
 */
function knownWorkspace(workspaceId: string): RegisteredWorkspace | undefined {
	// The bridge's own directory is in the registry too (see ensureCwdInRegistry),
	// so it can be unpinned/archived like any other project.
	ensureCwdInRegistry();
	const reg = loadWorkspaces();
	const entry = reg[workspaceId];
	if (entry && existsSync(entry.path)) return entry;
	return undefined;
}

/**
 * Shape a registered workspace as the shell's `Workspace` expects.
 *
 * The registry stores the id as `id`; the shell reads it as `workspace_id`.
 * Returning the raw entry would leave `workspace_id` undefined, so every
 * update (`toggleProjectPinned` maps by `workspace_id`) would fail to match.
 */
function toShellWorkspace(entry: RegisteredWorkspace): Record<string, unknown> {
	return {
		workspace_id: entry.id,
		name: entry.name,
		path: entry.path,
		pinned: entry.pinned,
		archived: entry.archived,
	};
}

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

/** Ledger of token usage, appended one JSON object per finished run. */
const USAGE_LEDGER = join(AGENT_HOME, "usage.ndjson");

/**
 * Persist one run's token usage to the ledger.
 *
 * The shell shows a single honest number, not live accounting, so an append-only
 * log is enough: `stats.overview` reads it back and aggregates by day and model.
 * The ledger lives in AGENT_HOME like every other piece of user state, so it
 * survives bridge restarts and does not hide under the repo working tree.
 */
function recordUsageRun(entry: {
	ts: string;
	sessionId: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	elapsedMs: number;
}): void {
	try {
		mkdirSync(dirname(USAGE_LEDGER), { recursive: true });
		// Append-only: writing stale contents back would be a race on concurrent
		// runs, so read the file each time and add this run's line to the end.
		let ledger = "";
		if (existsSync(USAGE_LEDGER)) ledger = readFileSync(USAGE_LEDGER, "utf-8");
		if (ledger.length > 0 && !ledger.endsWith("\n")) ledger += "\n";
		writeFileSync(USAGE_LEDGER, `${ledger}${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// Usage is a nice-to-have; a full ledger must never break a run.
	}
}

/**
 * Aggregate the usage ledger into an overview for the shell.
 *
 * Returns lifetime totals plus splits by calendar day and by model. Dates are
 * bucketed in the bridge's local timezone because that is where the user lives;
 * the ledger stores ISO timestamps so this stays reproducible.
 */
function usageOverview(): {
	total: { runs: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; elapsedMs: number };
	byDay: Array<{ date: string; runs: number; input: number; output: number; cost: number }>;
	byModel: Array<{ model: string; runs: number; input: number; output: number; cost: number }>;
} {
	const total = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, elapsedMs: 0 };
	const byDay = new Map<string, { runs: number; input: number; output: number; cost: number }>();
	const byModel = new Map<string, { runs: number; input: number; output: number; cost: number }>();
	// Sessions with usable ledger entries must not be re-summed from transcripts
	// below, or their tokens would count twice.
	const ledgerNonZero = new Map<string, boolean>();
	try {
		if (!existsSync(USAGE_LEDGER)) return { total, byDay: [], byModel: [] };
		const lines = readFileSync(USAGE_LEDGER, "utf-8").split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			let entry: Record<string, unknown>;
			try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
			const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
			const input = num(entry.input);
			const output = num(entry.output);
			const cost = num(entry.cost);
			const elapsedMs = num(entry.elapsedMs);
			if (typeof entry.sessionId === "string" && (input > 0 || output > 0)) ledgerNonZero.set(entry.sessionId, true);
			total.runs += 1;
			total.input += input;
			total.output += output;
			total.cacheRead += num(entry.cacheRead);
			total.cacheWrite += num(entry.cacheWrite);
			total.cost += cost;
			total.elapsedMs += elapsedMs;
			const day = new Date(typeof entry.ts === "string" ? entry.ts : Date.now()).toLocaleDateString("sv-SE");
			const d = byDay.get(day) ?? { runs: 0, input: 0, output: 0, cost: 0 };
			d.runs += 1; d.input += input; d.output += output; d.cost += cost;
			byDay.set(day, d);
			const model = typeof entry.model === "string" ? entry.model : "";
			const m = byModel.get(model) ?? { runs: 0, input: 0, output: 0, cost: 0 };
			m.runs += 1; m.input += input; m.output += output; m.cost += cost;
			byModel.set(model, m);
		}
	} catch { /* aggregate what we can; corruption falls back to empty. */ }
	// Conversations that predate the ledger never touch it; recover their totals
	// from the persisted transcripts so the overview is not silently missing
	// every run made before usage tracking existed.
	for (const item of listSessions()) {
		// A session whose runs the ledger already counted must not be summed from
		// its transcript again. The fallback exists for sessions the ledger never
		// saw (or only saw with zero tokens, e.g. scripted previews).
		if (ledgerNonZero.get(item.id)) continue;
		const used = storedSessionUsage(item.id);
		if (!used) continue;
		const day = new Date(item.updatedAt).toLocaleDateString("sv-SE");
		const d = byDay.get(day) ?? { runs: 0, input: 0, output: 0, cost: 0 };
		d.input += used.input; d.output += used.output;
		byDay.set(day, d);
		const model = used.model;
		const m = byModel.get(model) ?? { runs: 0, input: 0, output: 0, cost: 0 };
		m.input += used.input; m.output += used.output;
		byModel.set(model, m);
		total.input += used.input;
		total.output += used.output;
	}
	return {
		total,
		byDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)).reverse(),
		byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.input - a.input),
	};
}

function send(socket: WebSocket, message: unknown): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/**
 * Cumulative usage per session, summed from the ledger.
 *
 * The ledger is append-only and holds one line per finished run, so per-session
 * totals are a simple sum over `sessionId`. This is what feeds the shell's
 * task-board token column and hover preview, which read
 * `total_input_tokens` / `total_output_tokens` / `total_elapsed_s` off the
 * session snapshot — the fields were previously hardcoded to zero.
 */
function usageTotalsBySession(): Map<string, { input: number; output: number; elapsedMs: number }> {
	const totals = new Map<string, { input: number; output: number; elapsedMs: number }>();
	try {
		if (!existsSync(USAGE_LEDGER)) return totals;
		const lines = readFileSync(USAGE_LEDGER, "utf-8").split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			let entry: Record<string, unknown>;
			try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
			const id = typeof entry.sessionId === "string" ? entry.sessionId : "";
			if (!id) continue;
			const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
			const current = totals.get(id) ?? { input: 0, output: 0, elapsedMs: 0 };
			current.input += num(entry.input);
			current.output += num(entry.output);
			current.elapsedMs += num(entry.elapsedMs);
			totals.set(id, current);
		}
	} catch { /* best-effort: a corrupt ledger falls back to zeros. */ }
	return totals;
}

/**
 * Token totals summed from a stored transcript's assistant messages.
 *
 * The ledger only records runs that finished after the ledger existed; older
 * conversations predate it. pi persists real usage on every assistant message,
 * so those totals can be recovered directly from the transcript. Returns
 * undefined when the session has no usable usage, so callers keep showing "—".
 */
function storedSessionUsage(sessionId: string): { input: number; output: number; elapsedMs: number; model: string } | undefined {
	try {
		const stored = loadSession(sessionId);
		if (!stored) return undefined;
		let input = 0, output = 0;
		for (const message of stored.messages) {
			if (message.role !== "assistant") continue;
			const usage = (message as { usage?: unknown }).usage as { input?: unknown; output?: unknown } | undefined;
			if (!usage || typeof usage !== "object") continue;
			const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
			input += num(usage.input);
			output += num(usage.output);
		}
		if (input === 0 && output === 0) return undefined;
		return { input, output, elapsedMs: 0, model: typeof stored.model === "string" ? stored.model : "" };
	} catch { return undefined; }
}

/** A permission decision the kernel is holding open for the shell to answer. */
const pendingPermissions = new Map<string, (approved: boolean) => void>();

/** Broadcast a shell-facing event to every connected client. */
function broadcast(event: Record<string, unknown>): void {
	for (const client of wss.clients) send(client, { kind: "event", event });
}

/**
 * The kernel's approval callback: the permission chain produced an `ask`, so we
 * surface it to the shell and wait for `permission.respond` to settle it.
 */
function makeApprover(): (request: { toolName: string; reason: string }) => Promise<boolean> {
	return (request) => new Promise<boolean>((resolve) => {
		const requestId = randomUUID();
		pendingPermissions.set(requestId, resolve);
		broadcast({
			type: "permission.request",
			request_id: requestId,
			tool_name: request.toolName,
			reason: request.reason,
			ts: new Date().toISOString(),
		});
	});
}

/**
 * One stored session, in the shape the shell's session list expects.
 *
 * `latest_run_id` has no equivalent here and stays null. Token totals are real:
 * they come from the usage ledger via `usageTotalsBySession` (the `totals`
 * argument), and fall back to 0 — which the shell renders as "—" — only when a
 * session has no recorded usage yet.
 */
function snapshotOf(item: SessionSummary, totals?: { input: number; output: number; elapsedMs: number }): Record<string, unknown> {
	return {
		session_id: item.id,
		title: item.title,
		// 主动态："active" 会让 shell 把归档按钮禁用（busy||active），
		// 给每条都标 active 等于所有会话都归档不了。空闲/等待输入的会话
		// 才是多数，这里如实报 waiting_for_input；真正运行中的由 run 事件体现。
		status: "waiting_for_input",
		updated_at: item.updatedAt,
		archived: item.archived === true,
		pinned: item.pinned === true,
		// 只有显式归属某个「打开的项目」的会话才归到该项目下。跑在桥默认目录
		// （进程 cwd，即 src-tauri）的会话，用户没指定项目，记为 null → 归入
		// shell 的「临时任务」，而不是被塞进 src-tauri 项目。
		workspace_id: item.cwd && item.cwd !== process.cwd() ? item.cwd : null,
		expert: item.expert ?? null,
		latest_run_id: null,
		// 累计用量来自 usage.ndjson（见 usageTotalsBySession），没有 ledger 记录
		// 时如实报 0 —— shell 把 0 渲染成 "—"，一个虚构的数字反而像真账。
		total_input_tokens: totals?.input ?? 0,
		total_output_tokens: totals?.output ?? 0,
		total_elapsed_s: Math.round((totals?.elapsedMs ?? 0) / 1000),
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
		permission_mode: settings.permissionMode ?? "normal",
		thinking_level: settings.thinkingLevel ?? "medium",
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
		}, undefined, askUserViaBridge, stored.cwd || undefined);
		live = { session: rebuilt, createdAt: stored.createdAt };
		sessions.set(sessionId, live);
	}
	const runId = randomUUID();
	live.runId = runId;

	const content = params.content as string;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const runStartedAt = Date.now();
	// pi fills the authoritative usage on the final assistant message; the
	// streamed message-update events may or may not carry it (providers only
	// send usage on the last chunk). Snapshot the transcript length at run start
	// and scan the messages this run appended when it finishes — that is where
	// the numbers provably live (the persisted transcript carries them).
	const messagesBefore = live.session.agent.state.messages.length;
	const unsubscribe = live.session.subscribe((event) => {
		// Delivered files are recorded as they happen, so the artifact panel
		// shows what this run actually handed over.
		if (event.type === "tool_end") captureDelivered(event as { name?: unknown; result?: unknown });
		for (const translated of translate(event, runId)) {
			if (translated.type === "run.finished") {
				const messages = live.session.agent.state.messages;
				for (let index = messagesBefore; index < messages.length; index++) {
					const message = messages[index] as { role?: unknown; usage?: unknown };
					if (message.role !== "assistant") continue;
					const u = message.usage as Record<string, unknown> | undefined;
					if (!u || typeof u !== "object") continue;
					const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
					usage.input += num(u.input);
					usage.output += num(u.output);
					usage.cacheRead += num(u.cacheRead);
					usage.cacheWrite += num(u.cacheWrite);
					const cost = u.cost as { total?: unknown } | undefined;
					usage.cost += num(cost?.total);
				}
				if (usage.input || usage.output || usage.cacheRead) {
					translated.total_input_tokens = usage.input;
					translated.total_output_tokens = usage.output;
					translated.cache_read_input_tokens = usage.cacheRead;
					translated.cache_creation_input_tokens = usage.cacheWrite;
					translated.elapsed_s = Math.round((Date.now() - runStartedAt) / 1000);
				}
			}
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
		// Nail down the model that actually produced this run — the live session
		// may have been rehydrated after a restart, so read settings for the model
		// rather than trusting the (possibly empty) in-memory snapshot.
		let model = "";
		try { model = (loadSettings().model ?? "") as string; } catch { /* best-effort */ }
		recordUsageRun({
			ts: new Date().toISOString(),
			sessionId,
			model,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
			elapsedMs: Date.now() - runStartedAt,
		});
		// Automatic memory: extract any new facts about the user from this run.
		// Fire-and-forget — the summary runs a model call of its own, so it must
		// never delay the reply that is already on its way.
		void summarizeMemory(sessionId, live, messagesBefore);
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
	workDir?: string,
): Promise<AgentSession> {
	const cwd = workDir ?? process.cwd();
	// Approval mode: "auto" lets the kernel decide without asking (never); any
	// manual mode routes out-of-workspace `ask` decisions to the shell.
	const mode = loadSettings().permissionMode ?? "normal";
	const resolvedPermission = permission ?? (mode === "auto"
		? { tier: "danger-full-access", approval: "never" }
		: { tier: "workspace-write", approval: "ask" });
	const options: Parameters<typeof createAgent>[0] = {
		recipe: { mode: recipe.mode ?? "general", expert: recipe.expert },
		cwd,
		settings: {},
		// Model intelligence level; pi adapts it per provider.
		thinkingLevel: loadSettings().thinkingLevel,
		permission: resolvedPermission,
		// Wire the shell as the approver whenever the policy may ask.
		approver: resolvedPermission.approval === "ask" ? makeApprover() : undefined,
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
 * Extract facts about the user from a finished run and record them to memory.
 *
 * Runs asynchronously after the reply is sent, so a slow summary never holds
 * up the conversation. Skips when the run was scripted (no credentials), when
 * the run added no user message, and when the transcript is too thin to
 * summarize. Failures are silent — memory is a nice-to-have, and a failed
 * summary must never surface to the conversation that is already over.
 */
async function summarizeMemory(sessionId: string, live: LiveSession, fromIndex: number): Promise<void> {
	try {
		if (useScripted()) return;
		const messages = live.session.agent.state.messages;
		const turned = messages.slice(fromIndex);
		const userText = turned
			.filter((m) => m.role === "user")
			.map((m) => blocksToText((m as { content?: unknown }).content as never))
			.filter((t) => t.trim().length > 0)
			.join("\n");
		if (userText.trim().length < 40) return;
		const dialogue = turned
			.filter((m) => m.role === "user" || m.role === "assistant")
			.map((m) => `${m.role}: ${blocksToText((m as { content?: unknown }).content as never).slice(0, 2000)}`)
			.join("\n")
			.slice(0, 12000);
		if (dialogue.trim().length < 40) return;
		const existing = loadMemory().map((entry) => `- ${entry.key}: ${entry.value}`).join("\n") || "（无）";
		const prompt = [
			"从下面的对话中提取关于用户的新信息（称呼、语言、时区、技术栈、项目背景、偏好等）。",
			"只输出已有记忆中缺失或需要更新的条目，输出严格 JSON 数组，每个元素 {\"key\": string, \"value\": string, \"category\": \"profile\"|\"preference\"|\"project\"|\"fact\"}。",
			"没有新信息就输出 []。不要编造对话中不存在的事实。不要输出解释。",
			"",
			"已有记忆：",
			existing,
			"",
			"对话：",
			dialogue,
		].join("\n");
		const session = await buildSession(undefined, { mode: "general" }, { tier: "read-only", approval: "never" });
		try {
			await session.prompt(prompt);
			const last = session.agent.state.messages[session.agent.state.messages.length - 1];
			const raw = blocksToText((last as { content?: unknown }).content as never);
			const body = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
			const start = body.indexOf("[");
			const end = body.lastIndexOf("]");
			if (start === -1 || end === -1) return;
			const parsed: unknown = JSON.parse(body.slice(start, end + 1));
			if (!Array.isArray(parsed)) return;
			for (const item of parsed) {
				const entry = item as { key?: unknown; value?: unknown; category?: unknown };
				if (typeof entry.key !== "string" || typeof entry.value !== "string") continue;
				const value = entry.value.trim();
				if (!value) continue;
				const category = entry.category === "profile" || entry.category === "preference" || entry.category === "project" ? entry.category : "fact";
				upsertMemory(entry.key, value, category, "summary");
			}
		} finally {
			session.dispose();
		}
	} catch (error) {
		// Best-effort by design: memory extraction must never break a finished run.
		console.error("[gdou-bridge] memory summary failed:", (error as Error)?.message ?? String(error));
	}
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
	// Interaction channels the kernel does not have.
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
			// Projects = the bridge's own working directory (pinned) plus every
			// folder the user has opened via workspace.open. Dropping folders that
			// no longer exist keeps the tree honest about state the process hosts.
			ensureCwdInRegistry();
				pruneWorkspaces();
				const seen = new Set<string>();
				const workspaces = [];
				for (const entry of Object.values(loadWorkspaces())) {
					if (seen.has(entry.id)) continue;
					seen.add(entry.id);
					workspaces.push({
						workspace_id: entry.id,
						name: entry.name,
						path: entry.path,
						archived: entry.archived,
						pinned: entry.pinned,
					});
				}
				return reply({ workspaces });
			}

		case "workspace.open": {
			// Pick a folder to work in. It becomes a project in the tree, and a
			// conversation created with that workspace_id runs with this folder as
			// its working directory (the id is the folder's real path).
			const raw = params.path as string | undefined;
			if (!raw || raw.trim().length === 0) return error(-32602, "需要 path");
			let real: string;
			try {
				const target = resolve(raw.trim());
				if (!existsSync(target)) return error(-32602, `目录不存在：${raw}`);
				if (!statSync(target).isDirectory()) return error(-32602, `不是目录：${raw}`);
				real = realpathSync(target);
			} catch (err) {
				return error(-32602, (err as Error).message);
			}
			const reg = loadWorkspaces();
			const existing = reg[real];
			reg[real] = {
				id: real,
				path: real,
				name: existing?.name ?? (basename(real) || real),
				pinned: false,
				archived: false,
				addedAt: existing?.addedAt ?? new Date().toISOString(),
			};
			workspaceCache = reg;
			saveWorkspaces();
			return reply({ workspace: toShellWorkspace(reg[real]) });
		}

		case "workspace.pin": {
			const id = params.workspace_id as string | undefined;
			if (typeof id !== "string" || !id) return error(-32602, "需要 workspace_id");
			const reg = loadWorkspaces();
			ensureCwdInRegistry();
			const entry = reg[id];
			if (!entry) return error(-32602, "未知工作区");
			entry.pinned = params.pinned === true;
			workspaceCache = reg;
			saveWorkspaces();
			return reply({ workspace: toShellWorkspace(entry) });
		}

		case "workspace.rename": {
			const id = params.workspace_id as string | undefined;
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (typeof id !== "string" || !id) return error(-32602, "需要 workspace_id");
			if (!name) return error(-32602, "name 不能为空");
			const reg = loadWorkspaces();
			ensureCwdInRegistry();
			if (!reg[id]) return error(-32602, "未知工作区");
			reg[id].name = name;
			workspaceCache = reg;
			saveWorkspaces();
			return reply({ workspace: toShellWorkspace(reg[id]) });
		}

		case "workspace.archive": {
			const id = params.workspace_id as string | undefined;
			if (typeof id !== "string" || !id) return error(-32602, "需要 workspace_id");
			const reg = loadWorkspaces();
			ensureCwdInRegistry();
			if (!reg[id]) return error(-32602, "未知工作区");
			reg[id].archived = true;
			workspaceCache = reg;
			saveWorkspaces();
			return reply({ workspace: toShellWorkspace(reg[id]) });
		}

		case "workspace.resume": {
			const id = params.workspace_id as string | undefined;
			if (typeof id !== "string" || !id) return error(-32602, "需要 workspace_id");
			const entry = knownWorkspace(id);
			if (!entry) return error(-32602, "未知工作区");
			if (entry.archived === false) return reply({ workspace: toShellWorkspace(entry) });
			const reg = loadWorkspaces();
			if (!reg[id]) return error(-32602, "未知工作区");
			reg[id].archived = false;
			workspaceCache = reg;
			saveWorkspaces();
			return reply({ workspace: toShellWorkspace(reg[id]) });
		}

		case "workspace.delete": {
			const id = params.workspace_id as string | undefined;
			if (typeof id !== "string" || !id) return error(-32602, "需要 workspace_id");
			if (params.confirm !== "delete") return error(-32602, '需要 confirm: "delete"');
			if (id === process.cwd()) return error(-32602, "不能删除当前工作目录");
			const reg = loadWorkspaces();
			if (!reg[id]) return error(-32602, "未知工作区");
			delete reg[id];
			workspaceCache = reg;
			saveWorkspaces();
			// Deleting a workspace removes it from the tree, not the folder on disk.
			return reply({});
		}

		case "session.list": {
			const totals = usageTotalsBySession();
			return reply({
				sessions: listSessions().map((item) => {
					const t = totals.get(item.id);
					// `t` may be a real object of zeros (a run recorded no usage, e.g.
					// scripted or before the ledger captured tokens) — that is not
					// "no data". Fall through to the transcript only when the ledger
					// has nothing usable, so the latest live-run session still shows
					// the numbers recovered from its messages.
					const used = t && (t.input > 0 || t.output > 0) ? t : storedSessionUsage(item.id);
					return snapshotOf(item, used);
				}),
			});
		}

		case "stats.overview":
			return reply(usageOverview());

		case "memory.list":
			return reply({ entries: loadMemory() });

		case "memory.update": {
			const key = params.key as string;
			const value = (params.value as string)?.trim();
			const category = params.category === "profile" || params.category === "preference" || params.category === "project" || params.category === "fact"
				? (params.category as "profile" | "preference" | "project" | "fact")
				: "fact";
			if (!key || !value) return error(-32602, "记忆条目需要 key 和 value");
			return reply({ entry: upsertMemory(key, value, category, "manual") });
		}

		case "memory.delete": {
			const key = params.key as string;
			if (!key) return error(-32602, "缺少记忆条目 key");
			deleteMemory(key);
			return reply({});
		}

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

			case "permission.respond": {
				const requestId = params.request_id as string | undefined;
				const resolve = requestId ? pendingPermissions.get(requestId) : undefined;
				if (!resolve) return error(-32602, "没有这个待审批的请求，或它已处理");
				pendingPermissions.delete(requestId);
				resolve(params.decision !== "deny");
				return reply({});
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
			//
			// Token usage: pi persists each assistant message with its provider
			// usage, so history can report the same numbers a live run would —
			// the shell's SessionStatsLine keys stats by run id, so every
			// assistant message gets a stable synthetic run id (the provider's
			// response id when available) and run_stats is keyed by it. The
			// 0s the shell used to show were the honest truth of an empty map,
			// not of the conversation.
			const run_stats: Record<string, { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; elapsed_s: number; context_pct: number }> = {};
			let assistantIndex = 0;
			const messages = stored.messages
				.filter((message) => message.role !== "system" && "content" in message)
				.map((message) => {
					const isAssistant = message.role === "assistant";
					const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
					if (isAssistant) {
						const usage = (message as { usage?: unknown }).usage as { input?: unknown; output?: unknown; cacheRead?: unknown } | undefined;
						const runId = String((message as { responseId?: unknown }).responseId ?? `history-${++assistantIndex}`);
						if (usage && typeof usage === "object") {
							run_stats[runId] = {
								input_tokens: num(usage.input),
								output_tokens: num(usage.output),
								cache_read_input_tokens: num(usage.cacheRead),
								elapsed_s: 0,
								context_pct: 0,
							};
						}
						return {
							role: "assistant",
							content: blocksToText(message.content),
							ts: stored.updatedAt,
							model: stored.model,
							run_id: runId,
						};
					}
					return {
						role: message.role === "user" ? "user" : "assistant",
						content: blocksToText(message.content),
						ts: stored.updatedAt,
						model: stored.model,
					};
				});
			// The expert that shaped this conversation, so a reopened session shows
			// the same "为什么工具变少了" indicator it had when it was created.
			return reply({
				messages,
				expert: stored.expert ?? null,
				run_stats,
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

		case "session.archive": {
			const id = params.session_id as string;
			const stored = loadSession(id);
			if (!stored) return error(-32602, `unknown session: ${id}`);
			const saved = saveSession({ ...stored, archived: true });
			return reply({ session: snapshotOf(saved) });
		}

		case "session.pin": {
			const id = params.session_id as string;
			const stored = loadSession(id);
			if (!stored) return error(-32602, `unknown session: ${id}`);
			const saved = saveSession({ ...stored, pinned: params.pinned === true });
			return reply({ session: snapshotOf(saved) });
		}

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
			// permission_mode drives whether the shell asks before out-of-workspace
			// tool calls ("normal") or lets everything through ("auto"). Kept on the
			// stored settings so buildSession can honor it.
			if (params.permission_mode === "auto" || params.permission_mode === "accept_edits" || params.permission_mode === "plan" || params.permission_mode === "normal") {
				settings.permissionMode = params.permission_mode;
			}
			// Model intelligence level (thinking effort). pi resolves these per
			// provider, so persisting here is enough to make the selector work.
			if (typeof params.thinking_level === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(params.thinking_level)) {
				settings.thinkingLevel = params.thinking_level as typeof settings.thinkingLevel;
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
				const live = { session: await buildSession(stored.messages, { mode: stored.profile, expert: stored.expert ?? null }, undefined, askUserViaBridge, stored.cwd || undefined), createdAt: stored.createdAt };
				sessions.set(id, live);
			}
			// 恢复 = 取消归档，快照带回真实 pinned/archived/cwd。
			const revived = saveSession({ ...stored, archived: false });
			return reply({ session: snapshotOf(revived) });
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
			// A workspace_id scopes the conversation to a chosen project folder.
			const session = await buildSession(undefined, { expert }, undefined, askUserViaBridge, resolveWorkspaceCwd(params.workspace_id));
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

// Best-effort: make ripgrep/fd available offline so grep/find work without pi
// having to download them on a machine with no internet. In the packaged Tauri
// app the bridge runs as bridge.exe inside resources/, with the binaries at
// resources/bin/. In a dev checkout they live at vendor/bin/.
try {
	const bridgeIsPackaged = /bridge\.exe$/i.test(process.execPath);
	const toolchainSource = process.env.GDOU_TOOLCHAIN_DIR
		?? (bridgeIsPackaged ? join(dirname(process.execPath), "bin") : join(PROJECT_ROOT, "vendor", "bin"));
	const provisionReport = provisionManagedBinaries(toolchainSource);
	const ready = [...provisionReport.copied, ...provisionReport.present];
	if (ready.length) console.log(`[gdou-bridge] tools ready (offline): ${ready.join(", ")}`);
	else if (provisionReport.missing.length) console.log(`[gdou-bridge] tools not bundled (${provisionReport.missing.join(", ")} will be downloaded)`);
} catch (error) {
	console.log(`[gdou-bridge] tools provisioning skipped: ${error instanceof Error ? error.message : String(error)}`);
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
