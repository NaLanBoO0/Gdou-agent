/**
 * General profile - everyday tasks.
 *
 * No filesystem or shell access. The assistant answers, plans, and drafts, with
 * a scratchpad for carrying facts across turns. This is the safe default: a
 * misread instruction cannot damage anything.
 */

import { currentTimeTool } from "../tools/time.ts";
import { listNotesTool, saveNoteTool } from "../tools/notes.ts";
import { webFetchTool } from "../tools/web-fetch.ts";
import { webSearchTool } from "../tools/web-search.ts";
import type { AgentProfile, AnyTool, ProfileContext } from "./types.ts";

// Research tools are included because looking something up is an everyday task.
// `present_files` is not: it stats the paths it is given, and this mode's whole
// description is that it does not touch the filesystem.
const TOOLS: AnyTool[] = [
	currentTimeTool,
	saveNoteTool,
	listNotesTool,
	webSearchTool as unknown as AnyTool,
	webFetchTool as unknown as AnyTool,
];

export const generalProfile: AgentProfile = {
	id: "general",
	label: "General",
	description: "Everyday tasks: questions, planning, drafting, light analysis. No file or shell access.",
	thinkingLevel: "off",

	systemPrompt(context: ProfileContext) {
		return [
			"You are a helpful general-purpose assistant.",
			"",
			"You handle everyday tasks: answering questions, planning, drafting, organizing",
			"information, and light analysis.",
			"",
			`Working directory: ${context.cwd}`,
			`Current time: ${new Date().toISOString()}`,
			"",
			"Guidelines:",
			"- Answer directly and concisely. Lead with the answer, then explain if needed.",
			"- Use tools when they genuinely help; do not narrate tool use.",
			"- If a task needs file or shell access, say so and suggest the coding profile.",
		].join("\n");
	},

	tools() {
		return TOOLS;
	},
};
