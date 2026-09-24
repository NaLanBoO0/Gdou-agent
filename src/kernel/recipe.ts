/**
 * The session recipe: how a session is assembled.
 *
 * A session is not "a profile". It is a *combination*: a mode decides what the
 * agent is able to do, an expert decides how it goes about it. The two are
 * orthogonal and both can apply at once, which is the whole reason "expert" is
 * a separate concept from "mode" rather than another name for one.
 *
 * Keeping the recipe as one value (rather than a `mode` option and an `expert`
 * option that happen to sit next to each other) is what lets it be stored,
 * shown, and later reused by automations, which are "a stored recipe plus a
 * prompt plus a trigger".
 */

import type { Expert } from "../experts/types.ts";
import type { AnyTool } from "../profiles/types.ts";
import type { Skill } from "../skills/types.ts";

/**
 * What a caller asks for.
 *
 * An omitted mode falls back to settings and then the default. `expert` has
 * three states on purpose, because "no expert" and "you decide" are different
 * requests once a default expert exists in settings:
 *
 *   `"audit"`  use that expert
 *   `null`     use no expert, even though settings names one
 *   `undefined`/omitted   fall back to settings
 *
 * Without the `null` case a UI could not offer "no expert" while the user has a
 * default set — picking it would silently reinstate the default.
 */
export interface RecipeRequest {
	mode?: string;
	expert?: string | null;
}

/**
 * The recipe a session actually used.
 *
 * Ids only, never resolved objects, so it stays serializable — which is what
 * lets it be stored on a session, shown in the UI, and reused verbatim as the
 * recipe of an automation.
 */
export interface SessionRecipe {
	mode: string;
	expert?: string;
}

export interface ToolSelection {
	/** The tools the session will actually expose. */
	tools: AnyTool[];
	/**
	 * Tool names the expert asked for that the mode does not provide.
	 *
	 * Worth surfacing rather than dropping: an expert written for the coding
	 * mode silently losing half its tools in the general mode looks like the
	 * expert not working, and the cause is invisible from the outside.
	 */
	unavailable: string[];
}

/**
 * Apply an expert's tool allowlist to a mode's tool set.
 *
 * The result is an **intersection**, never a union, and that is a safety
 * property rather than a style choice. Experts are user-authored files, so if
 * one could add tools it could hand a sandboxed mode filesystem or shell
 * access — "install an expert" would mean "install a backdoor". Restricting
 * experts to subtraction means the worst a hostile expert can do is make the
 * agent less capable.
 *
 * Order follows the mode, so the visible tool order stays stable regardless of
 * how the expert happened to list them.
 */
export function narrowTools(modeTools: AnyTool[], expert: Expert | undefined): ToolSelection {
	if (!expert?.tools) return { tools: modeTools, unavailable: [] };

	const available = new Set(modeTools.map((tool) => tool.name));
	const allowed = new Set(expert.tools);

	// Named-but-absent first: it is the actionable half, and it is what explains
	// an unexpectedly small tool set.
	const unavailable = expert.tools.filter((name) => !available.has(name));
	return { tools: modeTools.filter((tool) => allowed.has(tool.name)), unavailable };
}

/**
 * Compose the mode's prompt with the expert's methodology and the skill catalog.
 *
 * The expert goes after the mode so it reads as the specific instruction that
 * qualifies the general one above it. The skill catalog goes last and carries
 * only names and one-line descriptions — never the bodies — which is the whole
 * of progressive disclosure: the model can route a task to a skill without
 * paying for the skill's full text, and it loads that text with `load_skill`
 * only when a task actually matches.
 *
 * The heading is English to match the mode prompts; the bodies themselves are
 * whatever language their authors wrote them in.
 */
export function composePrompt(modePrompt: string, expert: Expert | undefined, skills: Skill[] = [], memoryText?: string): string {
	const parts = [modePrompt];
	if (expert) {
		parts.push("", "---", "", `## Expert methodology: ${expert.label}`, "", expert.methodology);
	}
	if (memoryText && memoryText.trim().length > 0) {
		parts.push(memoryText.trimEnd());
	}
	if (skills.length > 0) {
		const catalog = skills
			.map((skill) => {
				const hint = skill.whenToUse ? ` — use when: ${skill.whenToUse}` : "";
				return `- \`${skill.id}\`: ${skill.description}${hint}`;
			})
			.join("\n");
		parts.push(
			"",
			"---",
			"",
			"## Available skills",
			"",
			"These skills are described here only by name and summary. Call the",
			"`load_skill` tool to read a skill's full instructions when a task matches.",
			"",
			catalog,
		);
	}
	return parts.join("\n");
}
