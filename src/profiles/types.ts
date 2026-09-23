/**
 * Profile contract.
 *
 * A profile bundles everything that differs between "daily tasks" and "coding
 * tasks": the system prompt, the tool set, and execution preferences. The kernel
 * itself is profile-agnostic - it just asks a profile for these three things.
 *
 * Adding a new mode (research, data analysis, customer support) means writing one
 * new file that satisfies this interface and registering it. No kernel changes.
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
	/** Build the system prompt. */
	systemPrompt(context: ProfileContext): string;
	/** Build the tool set. Async because tools may probe the filesystem. */
	tools(context: ProfileContext): AnyTool[] | Promise<AnyTool[]>;
	/** Override the global tool execution strategy. */
	toolExecution?: "parallel" | "sequential";
	/** Suggested thinking level for this profile. */
	thinkingLevel?: ThinkingLevel;
}
