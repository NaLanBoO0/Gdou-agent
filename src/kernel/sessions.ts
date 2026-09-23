/**
 * Session persistence.
 *
 * One conversation per file, at AGENT_HOME/sessions/<id>.json. Closing the
 * window no longer throws the conversation away, and starting a new topic no
 * longer overwrites the previous one.
 *
 * Each file holds two JSON lines:
 *
 *   {"id":...,"profile":...,"expert":...,"title":...,"updatedAt":...,"messageCount":...}
 *   {"version":1,...,"messages":[...]}
 *
 * `expert` is omitted when the session had none. Adding it did not need a format
 * bump: an older file simply lacks the field, which reads back as "no expert".
 *
 * The first line is a summary. Listing conversations reads only that line, so a
 * list of long conversations does not mean reading every conversation in full —
 * a transcript with file contents in its tool results can run to megabytes, and
 * the list is opened casually. The second line is the record proper.
 *
 * Writes go through a temp file and a rename, the same way settings do, so an
 * interrupted write cannot leave a half-file that fails to parse on the next
 * launch.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { blocksToText } from "./events.ts";
import { sessionsDir } from "../paths.ts";

/**
 * Bumped when the stored shape changes incompatibly. A file from an older
 * version is set aside rather than migrated: the transcript is a convenience,
 * and guessing at an old layout risks resuming a conversation that never
 * happened.
 */
const FORMAT_VERSION = 1;

/** Enough for the summary line; it holds a truncated title and a few fields. */
const SUMMARY_BYTES = 4096;

const TITLE_LIMIT = 40;

/** What a session list needs, without loading the conversation. */
export interface SessionSummary {
	id: string;
	/** Mode id. */
	profile: string;
	/**
	 * Expert id, when the session used one.
	 *
	 * Optional and read leniently, so transcripts written before experts existed
	 * keep loading without a format bump: the field is simply absent.
	 */
	expert?: string;
	title: string;
	updatedAt: string;
	messageCount: number;
}

export interface StoredSession extends SessionSummary {
	version: number;
	/** Model spec in use, recorded for diagnostics rather than for resuming. */
	model: string;
	cwd: string;
	createdAt: string;
	messages: AgentMessage[];
}

/** A stable, sortable, filesystem-safe identifier. */
export function createSessionId(now: Date = new Date()): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	const stamp = [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		"-",
		pad(now.getHours()),
		pad(now.getMinutes()),
		pad(now.getSeconds()),
	].join("");
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${stamp}-${suffix}`;
}

/**
 * A short label for the conversation, taken from the first thing the user said.
 *
 * More useful than a timestamp in a list, and it needs no extra bookkeeping
 * because the first user message is already in the transcript.
 */
export function titleOf(messages: readonly AgentMessage[]): string {
	for (const message of messages) {
		if (message.role !== "user") continue;
		const line = blocksToText(message.content).trim().split("\n")[0]?.trim() ?? "";
		if (line.length === 0) continue;
		return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
	}
	return "新对话";
}

function sessionPath(id: string): string {
	return join(sessionsDir(), `${id}.json`);
}

/**
 * Move an unreadable file aside instead of deleting it.
 *
 * A corrupt transcript is already unusable, but it is also the only copy of
 * something the user wrote. Renaming keeps it inspectable and stops the next
 * launch from tripping over it again.
 */
function quarantine(path: string): void {
	try {
		renameSync(path, `${path}.corrupt`);
	} catch {
		// Nothing more to do: the caller treats this as "no session".
	}
}

/** Read just the first line of a file, which is where the summary lives. */
function readSummaryLine(path: string): string | undefined {
	let handle: number | undefined;
	try {
		handle = openSync(path, "r");
		const buffer = Buffer.alloc(SUMMARY_BYTES);
		const bytes = readSync(handle, buffer, 0, SUMMARY_BYTES, 0);
		const text = buffer.subarray(0, bytes).toString("utf-8");
		const newline = text.indexOf("\n");
		return newline === -1 ? text : text.slice(0, newline);
	} catch {
		return undefined;
	} finally {
		if (handle !== undefined) closeSync(handle);
	}
}

function parseSummary(raw: string): SessionSummary | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;

	const record = parsed as Partial<SessionSummary>;
	if (typeof record.id !== "string" || typeof record.profile !== "string") return undefined;

	const summary: SessionSummary = {
		id: record.id,
		profile: record.profile,
		title: typeof record.title === "string" ? record.title : "新对话",
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
		messageCount: typeof record.messageCount === "number" ? record.messageCount : 0,
	};
	if (typeof record.expert === "string") summary.expert = record.expert;
	return summary;
}

/**
 * Summaries for every stored conversation, newest first.
 *
 * `profile` narrows the list to one mode. A profile decides the system prompt
 * and the tool set, so a coding conversation opened under the general profile
 * would resume something the agent never produced.
 */
export function listSessions(profile?: string): SessionSummary[] {
	let entries: string[];
	try {
		entries = readdirSync(sessionsDir());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const summaries: SessionSummary[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const summary = parseSummary(readSummaryLine(join(sessionsDir(), entry)) ?? "");
		if (!summary) continue;
		if (profile !== undefined && summary.profile !== profile) continue;
		summaries.push(summary);
	}

	return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSession(id: string): StoredSession | undefined {
	const path = sessionPath(id);

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}

	const lines = raw.split("\n");
	if (lines.length < 2) {
		quarantine(path);
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(lines[1] ?? "");
	} catch {
		quarantine(path);
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		quarantine(path);
		return undefined;
	}

	const record = parsed as Partial<StoredSession>;
	if (record.version !== FORMAT_VERSION || typeof record.id !== "string" || !Array.isArray(record.messages)) {
		quarantine(path);
		return undefined;
	}

	const loaded: StoredSession = {
		version: FORMAT_VERSION,
		id: record.id,
		profile: typeof record.profile === "string" ? record.profile : "",
		title: typeof record.title === "string" ? record.title : "新对话",
		model: typeof record.model === "string" ? record.model : "",
		cwd: typeof record.cwd === "string" ? record.cwd : "",
		createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
		messageCount: record.messages.length,
		messages: record.messages,
	};
	if (typeof record.expert === "string") loaded.expert = record.expert;
	return loaded;
}

/** What a caller supplies when saving. The title and count are derived unless given. */
export interface SessionDraft {
	id: string;
	profile: string;
	/** Expert id, when the session was assembled with one. */
	expert?: string;
	model: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	messages: AgentMessage[];
	/** Overrides the title derived from the first user message. */
	title?: string;
}

export function saveSession(session: SessionDraft): StoredSession {
	const path = sessionPath(session.id);
	mkdirSync(dirname(path), { recursive: true });

	const record: StoredSession = {
		version: FORMAT_VERSION,
		id: session.id,
		profile: session.profile,
		model: session.model,
		cwd: session.cwd,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		messages: session.messages,
		title: session.title?.trim() || titleOf(session.messages),
		messageCount: session.messages.length,
	};
	// Only set when present, so a session with no expert keeps its file free of
	// a null that later readers would have to interpret.
	if (session.expert !== undefined) record.expert = session.expert;

	// Summary first, so listing never has to read the rest.
	const summary: SessionSummary = {
		id: record.id,
		profile: record.profile,
		title: record.title,
		updatedAt: record.updatedAt,
		messageCount: record.messageCount,
	};
	if (record.expert !== undefined) summary.expert = record.expert;

	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(summary)}\n${JSON.stringify(record)}\n`, "utf-8");
	renameSync(temp, path);

	return record;
}

/**
 * Give a stored conversation a different title.
 *
 * The title is in both lines of the file — the summary so listing never reads
 * the record, the record so loading returns it — so this rewrites the whole
 * file. On a long conversation that is a few megabytes of writing, which is the
 * price of the two-line layout.
 *
 * An empty title is refused rather than applied: clearing the name would leave
 * a row in the list with nothing to click on, and there is no way to get the
 * derived one back.
 */
export function renameSession(id: string, title: string): SessionSummary | undefined {
	const trimmed = title.trim();
	if (trimmed.length === 0) return undefined;

	const session = loadSession(id);
	if (!session) return undefined;

	const saved = saveSession({ ...session, title: trimmed });
	const summary: SessionSummary = {
		id: saved.id,
		profile: saved.profile,
		title: saved.title,
		updatedAt: saved.updatedAt,
		messageCount: saved.messageCount,
	};
	if (saved.expert !== undefined) summary.expert = saved.expert;
	return summary;
}

/**
 * Whether a stored conversation was produced by this exact recipe.
 *
 * Both halves matter. The mode decides the system prompt and the tool set; the
 * expert decides the methodology and may narrow that tool set. Resuming under a
 * different one of either would replay a transcript the agent never produced —
 * a coding conversation replayed under general has tool calls with no matching
 * tools, and one expert's conversation replayed under another claims a method
 * that was never followed.
 */
export function matchesRecipe(
	summary: Pick<SessionSummary, "profile" | "expert">,
	mode: string,
	expert: string | undefined,
): boolean {
	return summary.profile === mode && summary.expert === expert;
}

export function deleteSession(id: string): void {
	try {
		unlinkSync(sessionPath(id));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Adopt the previous layout, where each profile had one rolling session at
 * `sessions/<profile>.json`.
 *
 * Called once at startup. Without it, a conversation stored by an earlier build
 * would simply vanish — the file is still there, but nothing lists it.
 */
export function migrateLegacySessions(): string[] {
	const adopted: string[] = [];

	let entries: string[];
	try {
		entries = readdirSync(sessionsDir());
	} catch {
		return adopted;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;

		// Legacy files are named after their profile; new ones carry an id.
		const profile = entry.slice(0, -".json".length);
		if (profile.includes("-") && /^\d{8}-\d{6}-/.test(profile)) continue;

		const path = join(sessionsDir(), entry);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf-8"));
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;

		const record = parsed as { messages?: unknown; profile?: unknown; model?: unknown; cwd?: unknown };
		if (!Array.isArray(record.messages) || record.messages.length === 0) continue;

		const id = createSessionId(statSync(path).mtime);
		saveSession({
			id,
			profile: typeof record.profile === "string" ? record.profile : profile,
			model: typeof record.model === "string" ? record.model : "",
			cwd: typeof record.cwd === "string" ? record.cwd : "",
			createdAt: statSync(path).mtime.toISOString(),
			updatedAt: statSync(path).mtime.toISOString(),
			messages: record.messages as AgentMessage[],
		});

		try {
			unlinkSync(path);
		} catch {
			// Leaving the old file costs nothing; it is no longer listed.
		}
		adopted.push(id);
	}

	return adopted;
}
