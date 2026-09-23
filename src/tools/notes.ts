/**
 * Scratchpad tools.
 *
 * A small persistent key-value store so the assistant can carry facts across
 * turns and sessions. Demonstrates a stateful tool that owns its own storage,
 * which is the pattern most custom tools will follow.
 *
 * Stored at AGENT_HOME/notes.json.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { notesPath } from "../paths.ts";

interface Note {
	key: string;
	value: string;
	updatedAt: string;
}

function readNotes(): Note[] {
	let raw: string;
	try {
		raw = readFileSync(notesPath(), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	return Array.isArray(parsed) ? (parsed as Note[]) : [];
}

function writeNotes(notes: Note[]): void {
	const path = notesPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(notes, null, "\t")}\n`, "utf-8");
	renameSync(temp, path);
}

const saveNoteSchema = Type.Object({
	key: Type.String({ description: "Short identifier, e.g. 'user_timezone'" }),
	value: Type.String({ description: "The value to remember" }),
});

export const saveNoteTool: AgentTool<typeof saveNoteSchema, { key: string; total: number }> = {
	name: "save_note",
	label: "Save note",
	description: "Store a short fact under a key so it can be recalled later, including in future sessions.",
	parameters: saveNoteSchema,

	async execute(_toolCallId, params) {
		const notes = readNotes();
		const updatedAt = new Date().toISOString();
		const existing = notes.findIndex((note) => note.key === params.key);
		if (existing === -1) {
			notes.push({ key: params.key, value: params.value, updatedAt });
		} else {
			notes[existing] = { key: params.key, value: params.value, updatedAt };
		}
		writeNotes(notes);
		return {
			content: [{ type: "text" as const, text: `Saved "${params.key}".` }],
			details: { key: params.key, total: notes.length },
		};
	},
};

const listNotesSchema = Type.Object({
	filter: Type.Optional(Type.String({ description: "Only return keys containing this substring" })),
});

export const listNotesTool: AgentTool<typeof listNotesSchema, { count: number }> = {
	name: "list_notes",
	label: "List notes",
	description: "List stored notes, optionally filtered by a substring of the key.",
	parameters: listNotesSchema,

	async execute(_toolCallId, params) {
		const notes = readNotes();
		const filter = params.filter?.toLowerCase();
		const matched = filter ? notes.filter((note) => note.key.toLowerCase().includes(filter)) : notes;
		if (matched.length === 0) {
			return {
				content: [{ type: "text" as const, text: "No notes stored." }],
				details: { count: 0 },
			};
		}
		const body = matched.map((note) => `${note.key} = ${note.value}`).join("\n");
		return {
			content: [{ type: "text" as const, text: body }],
			details: { count: matched.length },
		};
	},
};
