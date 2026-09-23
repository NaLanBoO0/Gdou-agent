/**
 * Preload script.
 *
 * The only bridge between the renderer and the kernel. It exposes a handful of
 * named functions rather than the raw `ipcRenderer`, so the renderer cannot
 * reach any channel that was not deliberately opened.
 *
 * Built as CJS: Electron loads an ESM preload only when the sandbox is off, and
 * turning the sandbox off is a real security downgrade for a local app that can
 * read the filesystem. For the same reason it must not be given the
 * `import.meta.url` banner the other bundles get — that banner calls
 * `require("node:url")`, which a sandboxed preload cannot resolve, and the
 * script would fail on its first line without reporting anything anywhere.
 */

import { contextBridge, ipcRenderer } from "electron";

/** One normalized agent event, as produced by the kernel's translation layer. */
type AgentEventPayload = { type: string } & Record<string, unknown>;

contextBridge.exposeInMainWorld("gdou", {
	/** Full diagnostics snapshot. */
	probe: () => ipcRenderer.invoke("kernel:probe"),

	/**
	 * Read a delivered artifact for preview.
	 *
	 * The main process refuses any path that did not come through
	 * `present_files` this session, so this is not a general file reader even
	 * though the signature suggests one.
	 */
	readArtifact: (path: string) => ipcRenderer.invoke("artifact:read", path),

	/** Profiles available to run. */
	profiles: () => ipcRenderer.invoke("agent:profiles"),

	/**
	 * Experts available for the current working directory.
	 *
	 * Resolves to `{ experts, errors }`: a malformed expert file is reported
	 * rather than hidden, because a silently missing expert looks exactly like a
	 * typo in its name.
	 */
	experts: () => ipcRenderer.invoke("agent:experts"),

	/** Skills available for the current working directory. Resolves to `{ skills, paths }`. */
	skills: () => ipcRenderer.invoke("agent:skills"),

	/**
	 * Credential rows, one per provider.
	 *
	 * Carries a masked hint and the credential's origin, never the key. There is
	 * deliberately no "read my key back" call: nothing in the interface needs
	 * one, and a channel that exists is a channel that can leak.
	 */
	credentials: () => ipcRenderer.invoke("credentials:list"),

	/** Save an API key. Resolves to the fresh rows, so the view cannot drift. */
	setCredential: (providerId: string, key: string) =>
		ipcRenderer.invoke("credentials:set", providerId, key),

	/** Remove a stored key. A key from the environment is untouched. */
	removeCredential: (providerId: string) => ipcRenderer.invoke("credentials:remove", providerId),

	/** Models of one provider, for the picker. */
	models: (providerId: string) => ipcRenderer.invoke("models:list", providerId),

	/**
	 * Choose the model a session runs on.
	 *
	 * Rebuilds the session, because the model is resolved when one is built —
	 * saving the choice alone would leave the status line describing a model the
	 * running agent is not using. An empty spec clears it.
	 */
	setModel: (spec: string) => ipcRenderer.invoke("agent:setModel", spec),

	/**
	 * Tear down any running session and build one for this recipe.
	 *
	 * `expertId` is `null` for "no expert", which is not the same as omitting it
	 * — omitting would fall back to the stored default.
	 *
	 * `scripted` asks for the preview transport, for machines with no provider
	 * credentials — without it there is no model and no interface to look at.
	 */
	start: (profileId: string, expertId: string | null, scripted?: boolean) =>
		ipcRenderer.invoke("agent:start", profileId, expertId, scripted),

	/** Send a user message. Resolves when the whole run finishes. */
	prompt: (text: string) => ipcRenderer.invoke("agent:prompt", text),

	/** Abort the in-flight run. */
	abort: () => ipcRenderer.invoke("agent:abort"),

	/** Dispose the session. */
	stop: () => ipcRenderer.invoke("agent:stop"),

	/** Stored conversations, newest first, optionally narrowed to one profile. */
	listSessions: (profileId?: string) => ipcRenderer.invoke("agent:listSessions", profileId),

	/** Open a stored conversation, resuming it where it left off. */
	openSession: (id: string) => ipcRenderer.invoke("agent:openSession", id),

	/** Begin a new conversation, leaving the current one on disk. */
	newSession: (profileId: string, expertId: string | null) =>
		ipcRenderer.invoke("agent:newSession", profileId, expertId),

	/** Remove a stored conversation. */
	deleteSession: (id: string) => ipcRenderer.invoke("agent:deleteSession", id),

	/** Rename a stored conversation. An empty title is refused, not applied. */
	renameSession: (id: string, title: string) => ipcRenderer.invoke("agent:renameSession", id, title),

	/** Open the OS directory picker. Resolves to the chosen path, or null. */
	pickDirectory: () => ipcRenderer.invoke("agent:pickDirectory"),

	/** Store a working directory and rebuild the session against it. */
	setCwd: (path: string) => ipcRenderer.invoke("agent:setCwd", path),

	/**
	 * Window chrome.
	 *
	 * The window is frameless, so these are the only way to move or close it —
	 * there is no OS titlebar behind them to fall back on.
	 */
	window: {
		minimize: () => ipcRenderer.invoke("window:minimize"),
		toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
		close: () => ipcRenderer.invoke("window:close"),
	},

	/**
	 * Subscribe to maximize/unmaximize.
	 *
	 * Needed because the user can maximize by double-clicking the drag region or
	 * through the OS, neither of which the renderer sees — so it cannot infer the
	 * state, only be told.
	 */
	onWindowState: (listener: (maximized: boolean) => void) => {
		const handler = (_event: unknown, maximized: boolean) => listener(maximized);
		ipcRenderer.on("window:state", handler);
		return () => ipcRenderer.removeListener("window:state", handler);
	},

	/** Subscribe to normalized events. Returns an unsubscribe function. */
	onEvent: (listener: (event: AgentEventPayload) => void) => {
		const handler = (_event: unknown, payload: AgentEventPayload) => listener(payload);
		ipcRenderer.on("agent:event", handler);
		return () => ipcRenderer.removeListener("agent:event", handler);
	},

	/**
	 * Subscribe to session changes.
	 *
	 * Fires whenever the running session is replaced — starting, clearing, or
	 * adopting a working directory — so the window redraws from one place
	 * instead of each call site remembering to do it.
	 */
	onSession: (listener: (session: unknown) => void) => {
		const handler = (_event: unknown, payload: unknown) => listener(payload);
		ipcRenderer.on("agent:session", handler);
		return () => ipcRenderer.removeListener("agent:session", handler);
	},
});
