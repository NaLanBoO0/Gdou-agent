/**
 * Persistent user memory.
 *
 * Unlike the scratchpad notes (`src/tools/notes.ts`, a manual key-value store
 * the model calls through `save_note`/`list_notes`), this is the *automatic*
 * memory: facts about the user — how they want to be called, what language
 * they speak, which project they work on, what they prefer — extracted after
 * conversations and re-injected into the system prompt of later sessions, so
 * the agent is never a blank slate again.
 *
 * Stored at AGENT_HOME/memory.json, one array of entries. Written atomically
 * (temp + rename), like every other piece of user state in this project.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AGENT_HOME } from "../paths.ts";

/** What kind of fact an entry holds; the management UI groups by it. */
export type MemoryCategory = "profile" | "preference" | "project" | "fact";

export interface MemoryEntry {
	key: string;
	value: string;
	category: MemoryCategory;
	/** Where the entry came from: a summary pass, or the user editing the UI. */
	source: "summary" | "manual";
	updatedAt: string;
}

export function memoryPath(): string {
	return `${AGENT_HOME}/memory.json`;
}

function readEntries(): MemoryEntry[] {
	try {
		const raw = readFileSync(memoryPath(), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is MemoryEntry => {
			if (typeof entry !== "object" || entry === null) return false;
			const e = entry as Record<string, unknown>;
			return typeof e.key === "string" && typeof e.value === "string" && e.value.trim().length > 0;
		});
	} catch {
		return [];
	}
}

function writeEntries(entries: MemoryEntry[]): void {
	const path = memoryPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(entries, null, "\t")}\n`, "utf-8");
	renameSync(temp, path);
}

/** All remembered facts. */
export function loadMemory(): MemoryEntry[] {
	return readEntries();
}

/** A stable snapshot sorted newest-first, what the prompt and UI render. */
export function memorySnapshot(): MemoryEntry[] {
	return readEntries().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Insert or update one fact.
 *
 * The same key overwrites (a summary correcting an earlier guess, or the user
 * editing a value in the UI), so memory never grows unbounded duplicates.
 */
export function upsertMemory(
	key: string,
	value: string,
	category: MemoryCategory = "fact",
	source: MemoryEntry["source"] = "summary",
): MemoryEntry {
	const trimmed = value.trim();
	const entries = readEntries();
	const index = entries.findIndex((entry) => entry.key === key);
	const entry: MemoryEntry = { key, value: trimmed, category, source, updatedAt: new Date().toISOString() };
	if (index === -1) entries.push(entry);
	else entries[index] = entry;
	writeEntries(entries);
	return entry;
}

/** Remove a fact. */
export function deleteMemory(key: string): void {
	writeEntries(readEntries().filter((entry) => entry.key !== key));
}

/** One-line rendering for the injected prompt paragraph. */
export function memoryPromptBlock(entries: MemoryEntry[]): string {
	const lines = entries.map((entry) => `- ${entry.key}: ${entry.value}`);
	return ["", "---", "", "## User memory", "", "Facts about the person you are talking to, kept across conversations.", "Treat them as true until the user corrects them; never ask again for something recorded here.", "", ...lines].join("\n");
}
