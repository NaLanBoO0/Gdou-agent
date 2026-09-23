/**
 * Electron main process.
 *
 * The pi kernel runs here, in-process. Electron's main process is Node, so the
 * agent needs no sidecar process, no HTTP hop, and no rewrite: the same
 * `createAgent` the CLI and TUI call is called here.
 *
 * The renderer never touches the kernel directly. It asks over IPC and receives
 * plain JSON, which keeps `contextIsolation` on and `nodeIntegration` off.
 *
 * One session exists at a time. Switching profile tears the old one down rather
 * than running two, because a profile decides the system prompt and the tool
 * set — running two would mean the transcript no longer describes one agent.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { AgentSession } from "../src/kernel/agent.ts";
import { createAgent } from "../src/kernel/agent.ts";
import { loadSettings, saveSettings } from "../src/config/settings.ts";
import { authPath, providerCredentials, removeApiKey, setApiKey } from "../src/kernel/credentials.ts";
import { scriptedRun, scriptedRunEnabled } from "../src/kernel/demo.ts";
import { replay, type AgentEvent } from "../src/kernel/events.ts";
import { armMemoryWatch, logLine, writeCrashRecord } from "../src/kernel/observability.ts";
import { narrowTools } from "../src/kernel/recipe.ts";
import { ModelRuntime } from "../src/kernel/runtime.ts";
import {
	createSessionId,
	deleteSession,
	listSessions,
	loadSession,
	matchesRecipe,
	migrateLegacySessions,
	renameSession,
	saveSession,
} from "../src/kernel/sessions.ts";
import { provisionManagedBinaries, type ProvisionReport, toolchainPaths } from "../src/kernel/toolchain.ts";
import { getExpert, loadExperts } from "../src/experts/registry.ts";
import { listSkills } from "../src/skills/registry.ts";
import { AGENT_HOME, describePiSource, expertsDir, IS_BUNDLED, PROJECT_ROOT, logsDir, projectExpertsDir, projectSkillsDir, skillsDir } from "../src/paths.ts";
import { getProfile, listProfiles } from "../src/profiles/registry.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the shipped ripgrep and fd binaries live.
 *
 * `extraResources` puts them beside the asar, not inside it, so they are read
 * from `process.resourcesPath` once packaged. In development there is no
 * packaging step, so the fetch script's output directory is used directly.
 */
function bundledBinariesDir(): string {
	return app.isPackaged ? join(process.resourcesPath, "bin") : join(PROJECT_ROOT, "vendor", "bin");
}

// Done once, before any window exists: pi looks in its bin directory before it
// would download, so getting the binaries in place first is what makes the
// coding tools work without a network.
const provisionReport: ProvisionReport = provisionManagedBinaries(bundledBinariesDir());

// ---------------------------------------------------------------- session

/** What the renderer needs to describe the running agent. Plain data only. */
interface SessionInfo {
	/** Identifier of the conversation being written to. */
	sessionId: string;
	/** Label for the conversation list, from its first user message. */
	title: string;
	profile: { id: string; label: string; description: string };
	/** The expert layered on top of the mode, or null when there is none. */
	expert: { id: string; label: string; description: string } | null;
	model: { provider: string; id: string; name: string };
	/**
	 * Whether pi can resolve auth for `model` right now.
	 *
	 * Reported so the interface can say "this one is callable" *before* a request
	 * fails, rather than after. It is asked of the resolution layer instead of
	 * inferred from the credential file, because the file is not the whole story:
	 * a key stored for a different provider, an expired OAuth token, and a
	 * provider that needs something other than a key all look configured on disk
	 * and fail the moment they are used.
	 */
	modelReady: boolean;
	/**
	 * The model a failed request would be retried on, or null when none is set.
	 *
	 * Disclosed rather than kept internal: a reply that quietly came from a
	 * different model than the one on the status line is the sort of thing a
	 * user should have been told about *before* it happened. The notice the
	 * kernel raises at the moment of the switch says it did happen; this says it
	 * could.
	 */
	fallback: { provider: string; id: string } | null;
	cwd: string;
	toolCount: number;
	/**
	 * Names of the tools the session actually exposes.
	 *
	 * Sent so the inspector can show them. The count alone cannot answer "why
	 * can it not read files", which is the question an expert that narrowed the
	 * set actually provokes.
	 */
	tools: string[];
	/**
	 * Tools the expert asked for that the mode does not provide.
	 *
	 * Sent to the renderer because an expert written for one mode quietly losing
	 * tools in another looks like the expert not working, and the reason is not
	 * visible from the interface otherwise.
	 */
	unavailableTools: string[];
	/** True when a scripted transport is driving the run instead of a provider. */
	scripted: boolean;
	/** How many stored messages were restored, zero for a fresh conversation. */
	resumed: number;
}

/** A started session, plus the events that redraw whatever it resumed. */
interface SessionStart {
	info: SessionInfo;
	history: AgentEvent[];
}

let session: AgentSession | undefined;
/** The conversation being appended to. */
let activeSessionId: string | undefined;
let activeProfileId: string | undefined;
/** Expert id the running session was assembled with, if any. */
let activeExpertId: string | undefined;
let activeCreatedAt: string | undefined;
/**
 * Paths the model has handed over with `present_files` this session.
 *
 * The renderer previews artifacts by asking the main process to read them, and
 * this is the allowlist for that channel. Without it the channel would be a
 * general file-read primitive reachable from the renderer, which would put the
 * permission gate out of circuit — the model could ask the UI to read what the
 * gate refused. Cleared on every session start so the allowlist cannot outlive
 * the session that earned it.
 */
const presentedPaths = new Set<string>();

/**
 * Largest artifact the preview panel will read.
 *
 * The content crosses IPC in one piece and is held by the renderer, so this is
 * a window-liveness limit rather than a disk one. 2 MB covers generated HTML,
 * reports, and images comfortably; anything larger is offered as a file to open
 * externally instead.
 */
const ARTIFACT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Add a tool result's delivered paths to the preview allowlist. */
function collectPresented(result: unknown): void {
	if (typeof result !== "object" || result === null) return;
	const details = (result as Record<string, unknown>).details;
	if (typeof details !== "object" || details === null) return;
	const items = (details as Record<string, unknown>).items;
	if (!Array.isArray(items)) return;
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		// Only files can be previewed; a URL is opened in the browser instead.
		if (record.kind === "file" && typeof record.target === "string") presentedPaths.add(record.target);
	}
}

/** True when a scripted transport is driving the session. */
let activeScripted = false;
/**
 * True when the session came from the preview button.
 *
 * Separate from `activeScripted`: the environment variable drives the same
 * transport but for development, and those runs are ordinary sessions. Only a
 * preview the user asked for is kept out of history.
 */
let activePreview = false;

function currentSession(): AgentSession {
	if (!session) throw new Error("No session is running. Pick a profile first.");
	return session;
}

function stopSession(): void {
	session?.dispose();
	session = undefined;
}

/**
 * The directory the agent works in.
 *
 * A stored choice wins. Without one the user's home is used rather than
 * `process.cwd()`, because a packaged app is launched from the Start menu,
 * where the process directory is whatever the shell happened to be in — not a
 * meaningful answer for a tool that reads and edits files. A predictable
 * directory beats an arbitrary one until the user picks their own.
 */
function resolveCwd(): string {
	return loadSettings().cwd ?? homedir();
}

/**
 * Override the context budget, in characters.
 *
 * Exposed so the pruning path can be exercised end to end without building a
 * megabyte of conversation first. It is also a real knob: someone running a
 * model with a small window may want the limit well below the default.
 */
function contextBudget(): number | undefined {
	const raw = process.env.GDOU_CONTEXT_BUDGET;
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** How to start a session, when the defaults are not what is wanted. */
interface StartOptions {
	cwd?: string;
	sessionId?: string;
	/**
	 * Expert to layer on the mode.
	 *
	 * `null` means "no expert" and is not the same as omitting it: omitted falls
	 * back to the stored default, which is what the window wants on first open,
	 * while `null` is what the picker sends when the user chooses none.
	 */
	expert?: string | null;
	/**
	 * Force the scripted transport, regardless of the environment.
	 *
	 * Used by the preview entry point, which exists because a machine with no
	 * provider credentials otherwise has no way to see the interface at all.
	 */
	scripted?: boolean;
}

/**
 * Build a session and start forwarding its events.
 *
 * `sessionId` resumes a stored conversation; without one a new conversation is
 * started. Resuming is refused when the stored conversation belongs to another
 * recipe, because the mode decides the system prompt and the tool set and the
 * expert decides the methodology and may narrow those tools — replaying a
 * transcript under either a different mode or a different expert would restore
 * something the agent never produced.
 */
async function startSession(profileId: string, options: StartOptions = {}): Promise<SessionStart> {
	stopSession();

	// Resolved here rather than left to `createAgent`. The same value decides
	// whether a stored conversation may be resumed, and two independent
	// resolutions could disagree — letting a transcript resume under an expert
	// other than the one it was written with.
	const expertId = options.expert === null ? undefined : (options.expert ?? loadSettings().expert);

	const stored = options.sessionId ? loadSession(options.sessionId) : undefined;
	const usable = stored && matchesRecipe(stored, profileId, expertId) ? stored : undefined;

	const cwd = options.cwd ?? usable?.cwd ?? resolveCwd();

	// Resolved after `cwd`, because a mode may come from a project-level file
	// (`<cwd>/.gdou-agent/modes/`) — the working directory decides which modes
	// exist, exactly as it does for experts. An unknown id therefore fails here,
	// which is the intended outcome for a stored recipe whose file was removed.
	const profile = getProfile(profileId, cwd);

	activeSessionId = usable?.id ?? createSessionId();
	activeProfileId = profileId;
	activeExpertId = expertId;
	activeCreatedAt = usable?.createdAt ?? new Date().toISOString();

	// Explicit wins, then the environment, then whatever the previous session
	// used — so adopting a directory or opening another conversation does not
	// silently drop a preview back into a transport the machine cannot reach.
	if (options.scripted !== undefined) {
		activeScripted = options.scripted;
		// An explicit request comes from the preview button: a demonstration the
		// user asked for, kept out of their history. The environment variable is
		// a developer switch and gets no such treatment — its runs are ordinary
		// sessions that happen to be driven by a script.
		activePreview = options.scripted;
	} else if (scriptedRunEnabled()) {
		activeScripted = true;
	}

	// The scripted transport has to know which tools the session exposes, so it
	// never scripts a call to something that does not exist. The expert narrows
	// that set, so it is applied here too — otherwise a scripted run would call
	// a tool the session does not have.
	const expert = expertId === undefined ? undefined : getExpert(expertId, cwd);
	const scripted = activeScripted
		? scriptedRun(
				narrowTools(await profile.tools({ cwd }), expert).tools.map((tool) => tool.name),
				cwd,
			)
		: undefined;

	const started = await createAgent({
		// `?? null` rather than passing `expertId` through: it is already fully
		// resolved, so an absent expert must not fall back to the stored default
		// a second time.
		recipe: { mode: profileId, expert: expertId ?? null },
		cwd,
		model: scripted?.model,
		streamFn: scripted?.streamFn,
		messages: usable?.messages,
		contextBudgetChars: contextBudget(),
		// Prompt-cache affinity: providers that route caches key on this, so the
		// requests of one conversation keep landing on the same cache.
		sessionId: activeSessionId,
		// The stored preferences — model, thinking level, permission tier,
		// fallback, loop guard — all live here. Omitting this is what once made
		// `agent:setModel` appear to do nothing: it saved the choice to disk and
		// then rebuilt the session without handing the settings back, so the
		// kernel resolved the model from the mode default instead of the value
		// the user just picked. Every preference, not just the model, depends on
		// this line.
		settings: loadSettings(),
	});

	session = started;
	presentedPaths.clear();
	// One line per session is cheap and answers "what model/mode/cwd was it
	// actually running" without re-deriving it from a crash or a screenshot.
	logLine(
		`session started: mode=${profileId} expert=${started.expert?.id ?? "-"} model=${started.model.provider}/${started.model.id} cwd=${cwd} scripted=${scripted ? "yes" : "no"}`,
	);
	started.subscribe((event) => {
		// Remember what the model handed over. The preview channel reads files,
		// so it must be limited to paths that went through `present_files` —
		// otherwise the renderer would have a general file-read primitive and
		// the permission gate would be bypassed by asking the UI directly.
		if (event.type === "tool_end") collectPresented(event.result);
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed()) window.webContents.send("agent:event", event);
		}
	});

	// Asked of pi, not guessed from `auth.json`. `getAuth` is the same resolution
	// a request performs, so this answers "would a call to this model work"
	// instead of "is there a key lying around". A provider whose resolution throws
	// is not usable either, and a throw answers the same question with no.
	let modelReady = false;
	try {
		modelReady = (await started.runtime.models.getAuth(started.model)) !== undefined;
	} catch {
		modelReady = false;
	}

	const result: SessionStart = {
		info: {
			sessionId: activeSessionId,
			title: usable?.title ?? "新对话",
			profile: { id: profile.id, label: profile.label, description: profile.description },
			expert: started.expert
				? { id: started.expert.id, label: started.expert.label, description: started.expert.description }
				: null,
			model: { provider: started.model.provider, id: started.model.id, name: started.model.name },
			modelReady,
			fallback: started.fallback ? { provider: started.fallback.provider, id: started.fallback.id } : null,
			cwd,
			toolCount: started.agent.state.tools.length,
			tools: started.agent.state.tools.map((tool) => tool.name),
			unavailableTools: started.unavailableTools,
			scripted: scripted !== undefined,
			resumed: usable?.messages.length ?? 0,
		},
		// Replayed rather than sent as raw messages, so the renderer keeps
		// exactly one rendering path for both live and restored conversations.
		history: usable ? replay(usable.messages) : [],
	};

	// Announced rather than only returned. A session can change from several
	// places — starting, opening another, adopting a directory — and the window
	// should not depend on whichever call site remembered to redraw itself.
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send("agent:session", result);
	}

	return result;
}

/**
 * Persist the conversation.
 *
 * Called after every run, including failed and aborted ones: whatever reached
 * the transcript is worth keeping, and a run that died halfway is precisely the
 * one a user wants to look back at.
 */
function persistSession(): void {
	if (!session || !activeSessionId || !activeProfileId) return;

	// A preview is a demonstration, not a conversation. Writing it would put a
	// transcript the user never had into their history, where it would sit
	// alongside real work and be indistinguishable from it.
	if (activePreview) return;

	try {
		const draft: Parameters<typeof saveSession>[0] = {
			id: activeSessionId,
			profile: activeProfileId,
			model: `${session.model.provider}/${session.model.id}`,
			cwd: session.cwd,
			createdAt: activeCreatedAt ?? new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messages: [...session.agent.state.messages],
		};
		// Recorded so reopening the conversation restores the same recipe. It is
		// also what the resume guard compares against, so losing it would let the
		// conversation reopen under the wrong expert.
		if (activeExpertId !== undefined) draft.expert = activeExpertId;
		saveSession(draft);
	} catch (error) {
		// Losing persistence is a degraded experience, not a broken app; the
		// conversation in memory is unaffected.
		process.stderr.write(`could not save session: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

// -------------------------------------------------------------- diagnostics

/** Everything the diagnostics panel shows. Plain data only, safe to serialize. */
interface KernelProbe {
	versions: { electron: string; node: string; chrome: string };
	paths: {
		projectRoot: string;
		piSource: string;
		agentHome: string;
		logsDir: string;
		toolBinDir: string;
		bundled: boolean;
		packaged: boolean;
	};
	profiles: { id: string; label: string; description: string }[];
	models: { total: number; providers: number };
	binaries: { source: string; provisioned: string[]; present: string[]; missing: string[]; errors: string[] };
	credentials: string;
	agent: { ok: boolean; detail: string };
}

/**
 * Exercise the kernel the same way a real session would.
 *
 * Building a session is the meaningful test: it resolves a provider from the
 * environment, registers the profile's tools, and wires the event stream. A
 * missing API key is an expected outcome here, not a failure of the pipeline,
 * so it is reported rather than thrown.
 */
async function probeAgent(): Promise<{ ok: boolean; detail: string }> {
	try {
		const probe = await createAgent({});
		const detail = `${probe.profile.label} · ${probe.model.provider}/${probe.model.id} · ${probe.agent.state.tools.length} 个工具`;
		probe.dispose();
		return { ok: true, detail };
	} catch (error) {
		const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
		return { ok: false, detail: message ?? "unknown error" };
	}
}

async function probeKernel(): Promise<KernelProbe> {
	const runtime = ModelRuntime.create();
	const models = runtime.all();
	const providers = new Set(models.map((model) => model.provider));

	return {
		versions: {
			electron: process.versions.electron,
			node: process.versions.node,
			chrome: process.versions.chrome,
		},
		paths: {
			projectRoot: PROJECT_ROOT,
			piSource: describePiSource(),
			agentHome: AGENT_HOME,
			logsDir: logsDir(),
			toolBinDir: toolchainPaths().binDir,
			// Two independent signals: `IS_BUNDLED` is set by esbuild at build
			// time, `isPackaged` by Electron at install time. In development
			// they can disagree, which is exactly what makes them useful.
			bundled: IS_BUNDLED,
			packaged: app.isPackaged,
		},
		profiles: listProfiles(resolveCwd()).map((profile) => ({
			id: profile.id,
			label: profile.label,
			description: profile.description,
		})),
		models: { total: models.length, providers: providers.size },
		binaries: {
			source: bundledBinariesDir(),
			provisioned: provisionReport.copied,
			present: provisionReport.present,
			missing: provisionReport.missing,
			errors: provisionReport.errors,
		},
		credentials: runtime.credentialReport(),
		agent: await probeAgent(),
	};
}

// ------------------------------------------------------------------ window

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1180,
		height: 800,
		minWidth: 860,
		minHeight: 560,
		// Matches the shell's own background so the first paint does not flash a
		// different colour before the stylesheet lands.
		backgroundColor: "#f7f9fa",
		title: "Gdouwork",
		// The window is frameless and the app draws its own titlebar, which is
		// what the shell expects. `autoHideMenuBar` is moot without a
		// frame but is kept so a platform that insists on a menu bar hides it.
		frame: false,
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			preload: join(HERE, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	// Showing only once the first frame is ready avoids a white flash against
	// the dark background.
	window.once("ready-to-show", () => window.show());
	void window.loadFile(join(HERE, "renderer", "index.html"));

	// Reported so the maximize button can flip between maximize and restore. The
	// renderer cannot infer it: a user can maximize by double-clicking the drag
	// region, or via the OS, without the button being involved.
	const report = () => {
		if (window.isDestroyed()) return;
		window.webContents.send("window:state", window.isMaximized());
	};
	window.on("maximize", report);
	window.on("unmaximize", report);

	return window;
}

/** The window the renderer's chrome controls act on. */
function targetWindow(): BrowserWindow | undefined {
	return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

/**
 * One instance only.
 *
 * Two instances would share the same session directory and the same state
 * files, so a conversation could be written by both — and the last writer
 * silently wins. That is a data-loss shape, not a cosmetic one, so the second
 * instance exits rather than running alongside.
 *
 * Requested before `whenReady` because the lock has to be decided before
 * anything is opened or migrated; the loser must not have touched state yet.
 */
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
	app.quit();
} else {
	// Raised when a second launch is refused. The user's intent was "show me
	// the app", so surface the window that already exists rather than doing
	// nothing visible.
	app.on("second-instance", () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
}

// ------------------------------------------------------- crash and logging

// Registered at module scope, before any work, so a failure during startup is
// also captured. Each handler writes synchronously and never throws: it is the
// last code that runs before the process may die, and a second throw here is a
// crash with no record.
process.on("uncaughtException", (error) => {
	writeCrashRecord("uncaughtException", error);
});
process.on("unhandledRejection", (reason) => {
	writeCrashRecord("unhandledRejection", reason);
});
// The renderer dying is the failure mode we chased all afternoon without any
// clue; this turns "the page went away" into a file on disk.
app.on("render-process-gone", (_event, _webContents, details) => {
	writeCrashRecord("render-process-gone", new Error(`${details.reason} (exitCode ${details.exitCode})`));
});

void app.whenReady().then(() => {
	// Armed first so a crash anywhere later in this callback still leaves a trail.
	armMemoryWatch();
	logLine("main process ready");
	// A conversation stored by an earlier build lives under the old per-profile
	// name. Adopt it before any window asks for the list, or it would simply
	// stop appearing.
	migrateLegacySessions();

	ipcMain.handle("kernel:probe", () => probeKernel());

	/**
	 * Read a delivered artifact so the renderer can preview it.
	 *
	 * Two limits, both load-bearing:
	 *
	 *   - **Only paths from `present_files`.** The renderer has no filesystem
	 *     access, so this channel is the only way it can read anything; without
	 *     the allowlist it would be a general read primitive and the model
	 *     could reach, through the UI, a file the permission gate had refused.
	 *   - **Size cap.** The whole content is held in memory and handed across
	 *     IPC, so a large file would stall the window rather than merely fail.
	 */
	ipcMain.handle("artifact:read", async (_event, path: string) => {
		if (!presentedPaths.has(path)) throw new Error(`未交付的文件不可预览：${path}`);
		const stats = statSync(path);
		if (stats.size > ARTIFACT_PREVIEW_MAX_BYTES) {
			return { tooLarge: true, size: stats.size, limit: ARTIFACT_PREVIEW_MAX_BYTES };
		}
		const extension = extname(path).slice(1).toLowerCase();
		const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(extension);
		if (isImage) {
			const mime = extension === "svg" ? "image/svg+xml" : `image/${extension === "jpg" ? "jpeg" : extension}`;
			return { dataUrl: `data:${mime};base64,${readFileSync(path).toString("base64")}`, size: stats.size };
		}
		return { text: readFileSync(path, "utf-8"), size: stats.size, extension };
	});

	/**
	 * Open a delivered artifact in the OS's default application.
	 *
	 * Same allowlist as `artifact:read`: only a path the model handed over with
	 * `present_files` can be opened, so the model cannot use the UI to launch an
	 * arbitrary local file. `shell.openPath` resolves to a non-empty error string
	 * on failure and `""` on success, which maps cleanly onto the renderer's
	 * error handling.
	 */
	ipcMain.handle("artifact:open", async (_event, path: string) => {
		if (!presentedPaths.has(path)) throw new Error(`未交付的文件不可打开：${path}`);
		const error = await shell.openPath(path);
		if (error) throw new Error(error);
		return true;
	});

	/**
	 * Window chrome.
	 *
	 * The window is frameless, so these are the only way to move or close it —
	 * there is no OS titlebar behind them to fall back on. Each is a no-op when
	 * no window exists, which happens on macOS after the last one closes.
	 */
	ipcMain.handle("window:minimize", () => {
		targetWindow()?.minimize();
	});
	ipcMain.handle("window:toggleMaximize", () => {
		const window = targetWindow();
		if (!window) return;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
	});
	ipcMain.handle("window:close", () => {
		targetWindow()?.close();
	});

	/**
	 * Modes available for the current working directory.
	 *
	 * Resolved against the working directory rather than the process directory,
	 * because project-level modes live beside the code they describe — the same
	 * reason `agent:experts` does. `source` is passed through so the interface
	 * can say which file a mode came from; without it, a mode that is not
	 * behaving as written is indistinguishable from one that was not loaded.
	 */
	ipcMain.handle("agent:profiles", () =>
		listProfiles(resolveCwd()).map((profile) => ({
			id: profile.id,
			label: profile.label,
			description: profile.description,
			source: profile.source ?? null,
		})),
	);

	/**
	 * Experts available for the current working directory.
	 *
	 * Resolved against the working directory rather than the process directory,
	 * because project-level experts live beside the code they describe. Load
	 * errors are returned rather than thrown: one malformed file should not make
	 * the picker unusable, but it must not disappear silently either.
	 */
	ipcMain.handle("agent:experts", () => {
		const cwd = resolveCwd();
		const catalog = loadExperts(cwd);
		return {
			experts: catalog.experts.map((expert) => ({
				id: expert.id,
				label: expert.label,
				description: expert.description,
				/** The names it narrows to, or null when it has no opinion. */
				tools: expert.tools ?? null,
				thinkingLevel: expert.thinkingLevel ?? null,
				source: expert.source,
			})),
			errors: catalog.errors,
			// Where the loader looks, most specific first. Shown in the interface
			// because "where do I put my own expert" is otherwise unanswerable.
			paths: [`${join(projectExpertsDir(cwd), "<id>.md")}`, `${join(expertsDir(), "<id>.md")}`],
		};
	});

	/**
	 * The skills catalog, for the skills page.
	 *
	 * Skills already feed the prompt through progressive disclosure (E1); this is
	 * the *visible* half — what skills exist, what they are for, and where they
	 * live, so "how do I add one" is answerable the way it is for experts.
	 */
	ipcMain.handle("agent:skills", () => {
		const cwd = resolveCwd();
		const skills = listSkills(cwd);
		return {
			skills: skills.map((skill) => ({
				id: skill.id,
				label: skill.label,
				description: skill.description,
				whenToUse: skill.whenToUse,
				references: skill.references.map((reference) => reference.name),
				source: skill.source,
			})),
			// Where the loader looks, most specific first.
			paths: [`${join(projectSkillsDir(cwd), "<id>/SKILL.md")}`, `${join(skillsDir(), "<id>/SKILL.md")}`],
		};
	});

	/**
	 * Credential state per provider, for the settings view.
	 *
	 * The key itself never crosses this boundary. Each row carries a masked hint
	 * and where the credential came from, which answers "is this configured, and
	 * which key is it" without the value existing anywhere the renderer can read
	 * it. A renderer that could read keys could leak one into a log, a crash
	 * report, or a screenshot; one that can only read hints cannot.
	 *
	 * The file path travels with the rows so the page can say where keys live.
	 * That is not decoration: a user who cannot find the file has no way to
	 * remove a key by hand when the interface will not start.
	 */
	const credentialSnapshot = async () => ({ providers: await providerCredentials(), authPath: authPath() });

	ipcMain.handle("credentials:list", credentialSnapshot);

	/** Save a key, and return the fresh rows so the view cannot drift from disk. */
	ipcMain.handle("credentials:set", async (_event, providerId: string, key: string) => {
		await setApiKey(providerId, key);
		return credentialSnapshot();
	});

	/**
	 * Remove a stored key.
	 *
	 * Only touches the file. A key that arrived through the environment stays
	 * usable, and its row keeps saying so — deleting something we do not own
	 * would be a lie about what happened.
	 */
	ipcMain.handle("credentials:remove", async (_event, providerId: string) => {
		await removeApiKey(providerId);
		return credentialSnapshot();
	});

	/** Models of one provider, for the picker. */
	ipcMain.handle("models:list", (_event, providerId: string) =>
		ModelRuntime.create()
			.modelsFor(providerId)
			.map((model) => ({
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				reasoning: model.reasoning,
			})),
	);

	/**
	 * Choose the model a session runs on.
	 *
	 * Written to settings rather than held in this process so the choice survives
	 * a restart, and adopted by rebuilding the session — the model is resolved
	 * when a session is built, so anything else would leave the interface showing
	 * a model the running agent is not using. An empty spec clears the choice and
	 * goes back to picking a default.
	 */
	ipcMain.handle("agent:setModel", async (_event, spec: string) => {
		if (!activeProfileId) throw new Error("还没有会话。先选一个模式。");
		const next = spec.trim();
		if (next.length > 0 && !ModelRuntime.create().resolve(next)) {
			// Refused rather than stored. A spec that resolves to nothing fails at
			// the next session start, several clicks away from the one that caused
			// it, and reads as "the app broke".
			throw new Error(`Unknown model: ${next}`);
		}
		const settings = loadSettings();
		if (next.length > 0) settings.model = next;
		else delete settings.model;
		saveSettings(settings);
		return startSession(activeProfileId, {
			cwd: resolveCwd(),
			sessionId: activeSessionId,
			expert: activeExpertId ?? null,
		});
	});

	/**
	 * Open the window's session.
	 *
	 * Reopens the most recent conversation for the profile so the window shows
	 * where the user left off, rather than a blank page with their work hidden
	 * one click away. Starting a genuinely new conversation is a separate call.
	 *
	 * `scripted` asks for the preview transport. It exists because a machine
	 * with no provider credentials otherwise cannot start a session at all, and
	 * the interface would be unreachable.
	 */
	ipcMain.handle("agent:start", async (_event, profileId: string, expertId: string | null, scripted?: boolean) => {
		// A preview starts from nothing. Resuming a real conversation and then
		// answering it with scripted replies would put fabricated turns into a
		// transcript the user actually wrote.
		//
		// Only a conversation with the same recipe is a candidate: the mode and
		// the expert together decide the prompt and the tools, so resuming across
		// either one would restore something this agent never produced.
		const wanted = expertId ?? undefined;
		const [mostRecent] = scripted
			? []
			: listSessions(profileId).filter((summary) => matchesRecipe(summary, profileId, wanted));
		return startSession(profileId, { sessionId: mostRecent?.id, expert: expertId, scripted });
	});

	// Resolves when the whole run finishes, so the renderer can treat the
	// promise as "the turn is over" and rely on events for everything else.
	ipcMain.handle("agent:prompt", async (_event, text: string) => {
		try {
			await currentSession().prompt(text);
		} finally {
			persistSession();
		}
	});

	ipcMain.handle("agent:abort", () => {
		currentSession().abort();
	});

	ipcMain.handle("agent:stop", () => {
		stopSession();
	});

	/** Stored conversations, newest first, optionally narrowed to one profile. */
	ipcMain.handle("agent:listSessions", (_event, profileId?: string) => listSessions(profileId));

	/** Open a stored conversation, resuming it where it left off. */
	ipcMain.handle("agent:openSession", async (_event, id: string) => {
		const stored = loadSession(id);
		if (!stored) throw new Error(`找不到会话：${id}`);
		// `?? null`: reopening restores the recipe the conversation was written
		// with, including the case where that was no expert at all.
		return startSession(stored.profile, { cwd: stored.cwd, sessionId: id, expert: stored.expert ?? null });
	});

	/**
	 * Begin a new conversation.
	 *
	 * The current one is left on disk. Starting a new topic should not destroy
	 * the previous one — that is what the list is for.
	 */
	ipcMain.handle("agent:newSession", async (_event, profileId: string, expertId: string | null) =>
		startSession(profileId, { expert: expertId }),
	);

	ipcMain.handle("agent:deleteSession", (_event, id: string) => {
		deleteSession(id);
	});

	/** Rename a stored conversation. An empty title is refused, not applied. */
	ipcMain.handle("agent:renameSession", (_event, id: string, title: string) => {
		const renamed = renameSession(id, title);
		if (!renamed) throw new Error("会话名不能为空");
		return renamed;
	});

	/**
	 * Open the OS directory picker and report what was chosen.
	 *
	 * Deliberately does nothing else. Choosing and adopting are separate steps
	 * so the half that matters — validating, storing, and rebuilding the session
	 * — can be driven without a modal dialog, which no automated check can
	 * dismiss.
	 */
	ipcMain.handle("agent:pickDirectory", async () => {
		const [window] = BrowserWindow.getAllWindows();
		const options: Electron.OpenDialogOptions = { properties: ["openDirectory"], title: "选择工作目录" };
		const result = window
			? await dialog.showOpenDialog(window, options)
			: await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	/** Adopt a working directory: store it, then rebuild the session against it. */
	ipcMain.handle("agent:setCwd", async (_event, path: string) => {
		if (!activeProfileId) throw new Error("No session is running. Pick a profile first.");

		const resolved = resolve(path);
		if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`不是目录：${resolved}`);
		}

		saveSettings({ ...loadSettings(), cwd: resolved });
		// The expert is carried across: adopting a directory is not a request to
		// change the recipe, and dropping it would silently change the session.
		return startSession(activeProfileId, {
			cwd: resolved,
			sessionId: activeSessionId,
			expert: activeExpertId ?? null,
		});
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
	stopSession();
});
