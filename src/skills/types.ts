/**
 * Skill contract.
 *
 * A skill is a reusable procedure the agent can *load on demand*. It differs
 * from a mode (what the agent can do) and an expert (how it approaches
 * everything) in that it is **progressive disclosure**: at session start the
 * agent only sees each skill's name plus a one-line description, and it loads
 * the full body — plus any reference files it needs — only when a task matches.
 *
 * That disclosure is the entire point. A catalog of dozens of skills, each a
 * page of methodology, would be hundreds of thousands of tokens if injected
 * wholesale; the same catalog costs a few hundred tokens when reduced to names
 * and descriptions, and the body is only spent when it is actually used.
 */

export interface SkillReference {
	/** Filename within the skill's `references/` directory, e.g. `api.md`. */
	name: string;
	/** A short label shown when the agent is deciding whether to read it. */
	description: string;
}

export interface Skill {
	/** Stable identifier. The directory name for file-backed skills. */
	id: string;
	/** Display name, from the frontmatter `name`. */
	label: string;
	/** One-line description, shown in the catalog injected into the prompt. */
	description: string;
	/**
	 * When this skill is the right tool, from the frontmatter `when_to_use`.
	 *
	 * Kept short by design — a sentence, not a paragraph. This is what lets the
	 * model route a task to the right skill without the body being loaded, so a
	 * long version would defeat the point of the disclosure.
	 */
	whenToUse: string;
	/** The methodology: the `SKILL.md` body. Loaded only on demand. */
	body: string;
	/** Reference files available for on-demand loading. */
	references: SkillReference[];
	/** Where this skill came from, for diagnostics. */
	source: string;
}

/** One parsed skill, before it is given an id and a source. */
export interface SkillDraft {
	label: string;
	description: string;
	whenToUse: string;
	body: string;
	references: SkillReference[];
}
