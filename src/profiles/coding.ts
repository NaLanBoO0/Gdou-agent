/**
 * Coding profile - repository work.
 *
 * Reuses pi-coding-agent's eight built-in tools verbatim rather than
 * reimplementing them. They already handle the fiddly parts: output truncation,
 * file mutation queuing, binary detection, image reads, and ripgrep integration.
 *
 * `createAllTools` returns `AgentTool` objects directly, so they plug into the
 * pi-agent-core loop with no adapter.
 */

import { createAllTools } from "@earendil-works/pi-coding-agent/core/tools/index.ts";
import { presentFilesTool } from "../tools/present.ts";
import { webFetchTool } from "../tools/web-fetch.ts";
import { webSearchTool } from "../tools/web-search.ts";
import type { AgentProfile, AnyTool, ProfileContext } from "./types.ts";

/**
 * Tools this project contributes rather than pi.
 *
 * Pushed after the pi set and deliberately not gated by `enabledTools`:
 * narrowing a mode to a read-only reviewer should still leave it able to
 * research and hand back what it found.
 */
const OWN_TOOLS: AnyTool[] = [
	presentFilesTool as unknown as AnyTool,
	webFetchTool as unknown as AnyTool,
	webSearchTool as unknown as AnyTool,
];

/** Every tool name the coding profile can expose. */
export const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] as const;

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/**
 * Tools enabled by default. `write` and `edit` are included because this profile
 * exists to change code; drop them to get a read-only reviewer.
 */
export const DEFAULT_CODING_TOOLS: CodingToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface CodingProfileOptions {
	/** Restrict the tool set. Defaults to DEFAULT_CODING_TOOLS. */
	enabledTools?: CodingToolName[];
}

export function createCodingProfile(options: CodingProfileOptions = {}): AgentProfile {
	const enabled = new Set(options.enabledTools ?? DEFAULT_CODING_TOOLS);

	return {
		id: "coding",
		label: "Coding",
		description: "Repository work: read, search, edit, write, and run commands.",
		toolExecution: "parallel",

		systemPrompt(context: ProfileContext) {
			return [
				"You are a coding assistant working inside a software repository.",
				"",
				`Working directory: ${context.cwd}`,
				"",
				"Guidelines:",
				"- Read a file before editing it. Do not guess at contents.",
				"- Prefer targeted edits over full rewrites.",
				"- Match the surrounding code style and existing conventions.",
				"- After changing code, run the project's checks if it defines them.",
				"- Keep responses concise and technical. No filler.",
				"- Do not commit unless explicitly asked.",
			].join("\n");
		},

		async tools(context: ProfileContext): Promise<AnyTool[]> {
			const all = createAllTools(context.cwd) as unknown as Record<string, AnyTool>;
			const selected: AnyTool[] = [];
			for (const name of CODING_TOOL_NAMES) {
				if (!enabled.has(name)) continue;
				const tool = all[name];
				if (tool) selected.push(tool);
			}
			selected.push(...OWN_TOOLS);
			return selected;
		},
	};
}
