/**
 * Profile contract.
 *
 * A profile bundles everything that differs between "daily tasks" and "coding
 * tasks": the system prompt, the tool set, and execution preferences. The kernel
 * itself is profile-agnostic - it just asks a profile for these three things.
 *
 * Modes are normally written as markdown, not as code: one file under
 * `~/.gdou-agent/modes/` (or `<cwd>/.gdou-agent/modes/`) is a mode. This
 * interface is the small seam that file format compiles down to, and it stays
 * public because an embedding host may want to build a mode from code that no
 * file could express.
 */

import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * Tool arrays are heterogeneous over each tool's TypeBox schema parameter, which
 * TypeScript cannot express without erasing it. pi uses the same widening in
 * `AgentState.tools`, so this matches upstream.
 */
export type AnyTool = AgentTool<any>;

/** Inputs a profile may use when building its prompt and tools. */
export interface ProfileContext {
	/** Working directory. Coding tools operate here. */
	cwd: string;
}

export interface AgentProfile {
	/** Stable identifier used in settings and on the CLI. */
	id: string;
	/** Display name. */
	label: string;
	/** One-line description shown when listing profiles. */
	description: string;
	/**
	 * Where this mode came from, for diagnostics: a file path for anything
	 * loaded from disk, `(built-in) <id>` for the shipped ones.
	 *
	 * Optional because a mode built in code has no file to name, and naming a
	 * fake one would be worse than naming none.
	 */
	source?: string;
	/** Build the system prompt. */
	systemPrompt(context: ProfileContext): string;
	/** Build the tool set. Async because tools may probe the filesystem. */
	tools(context: ProfileContext): AnyTool[] | Promise<AnyTool[]>;
	/** Override the global tool execution strategy. */
	toolExecution?: "parallel" | "sequential";
	/** Suggested thinking level for this profile. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Model this mode is built for, as "provider/modelId".
	 *
	 * The lowest-precedence source of a model, below settings and below an
	 * explicit call-site spec. A mode naming a model is a *suggestion* from a
	 * file the user may not have written: the cheapest way to lose a user's
	 * trust in a configuration file is to have it silently override the choice
	 * they made for themselves.
	 *
	 * The useful case is a mode that only works well on one model — a
	 * long-context summarizer on a large-window model, say — where "works badly
	 * elsewhere" is worth saying out loud rather than leaving unsaid.
	 */
	model?: string;
}
