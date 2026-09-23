/**
 * The `load_skill` tool: progressive disclosure's execution point.
 *
 * At session start the model sees only each skill's name and one-line
 * description. This tool is how it pulls the full body — and, when it needs
 * more, a specific reference file — into the conversation at the moment it
 * actually needs it.
 *
 * Two decisions are worth stating:
 *
 * - **The tool reads from the registry, not the filesystem directly.** That way
 *   a skill the registry refuses to load (a broken `SKILL.md`) is not reachable
 *   through the back door of this tool, and the unknown-id error names the list
 *   of skills that *do* exist — the difference between "I do not know how" and
 *   "the file is broken".
 *
 * - **Only the skill's own body and references, never arbitrary paths.** A
 *   `load_skill` that accepted a path would be a general file reader wearing a
 *   disguise, and a general file reader is exactly what the permission gate is
 *   there to control. The name is an id in the registry, not a path.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { getSkill, readSkillReference } from "../skills/registry.ts";

const loadSkillSchema = Type.Object({
	skill: Type.String({ description: "The skill id to load, e.g. 'git-commit'" }),
	reference: Type.Optional(
		Type.String({ description: "A reference file within the skill to also load, by filename" }),
	),
});

export function loadSkillTool(cwd: string): AgentTool<typeof loadSkillSchema, { skill: string }> {
	return {
		name: "load_skill",
		label: "Load skill",
		description:
			"Load a skill's full instructions by id. Only the name and a one-line summary are in context until this is called. Optionally load one reference file too.",
		parameters: loadSkillSchema,

		async execute(_toolCallId, params) {
			const skill = getSkill(params.skill, cwd);

			const parts: string[] = [];
			if (skill.whenToUse) parts.push(`When to use: ${skill.whenToUse}`);
			parts.push(skill.body);

			let referenceBody: string | undefined;
			if (params.reference !== undefined) {
				referenceBody = readSkillReference(skill, cwd, params.reference);
			}

			const text = parts.join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				// The reference is returned separately from the main body so a
				// front-end that cares can distinguish "loaded the skill" from
				// "loaded extra material", and so the main body stays the primary
				// signal in the transcript.
				details: {
					skill: skill.id,
					reference: referenceBody,
				},
			};
		},
	};
}
