/**
 * Expert contract.
 *
 * An expert is a named methodology: how to approach a task, as opposed to what
 * the agent is able to do (that is the mode's job).
 *
 * The distinction matters because it is what makes the two composable. A mode
 * decides the capability boundary, an expert decides the method, and the two
 * combine into one session. If experts could widen the tool set, "install an
 * expert" would mean "install a backdoor" — so the only tool-related power an
 * expert has is to *narrow*.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface Expert {
	/** Stable identifier. The filename stem for file-backed experts. */
	id: string;
	/** Display name, from the frontmatter `name`. */
	label: string;
	/** One-line description, shown when listing. */
	description: string;
	/** The methodology text: the markdown body, appended to the mode's prompt. */
	methodology: string;
	/**
	 * Tool allowlist, from the frontmatter `tools`.
	 *
	 * Intersected with the mode's tools, never unioned. `undefined` means "no
	 * opinion" and leaves the mode's set alone; an empty array means "no tools",
	 * which is a legitimate thing to ask for.
	 */
	tools?: string[];
	/** Suggested thinking level. Loses to an explicit setting. */
	thinkingLevel?: ThinkingLevel;
	/** Where this expert came from, for diagnostics. */
	source: string;
}

/** One parsed expert, before it is given an id and a source. */
export interface ExpertDraft {
	label: string;
	description: string;
	methodology: string;
	tools?: string[];
	thinkingLevel?: ThinkingLevel;
}
