/**
 * Turn a markdown document into a mode.
 *
 * Modes were TypeScript objects; they are now data. The motivation is the same
 * one that put experts in markdown files: a capability that requires writing
 * TypeScript to extend is only extendable by the people who wrote the project.
 *
 * What a mode file can express is exactly what a mode *is*: a name, a
 * description, a system prompt (the body), the tool set it exposes, and three
 * execution preferences — thinking level, tool execution, and a model to
 * suggest. Tool *names* are resolved against `tool-catalog.ts`, so a file can
 * combine existing capabilities but cannot invent one — see that file for why
 * that limit is deliberate.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../config/settings.ts";
import { parseFrontmatter } from "../definitions/frontmatter.ts";
import { resolveTool, TOOL_FACTORIES, TOOL_NAMES } from "./tool-catalog.ts";
import type { AgentProfile, AnyTool, ProfileContext } from "./types.ts";

const TOOL_EXECUTION = ["parallel", "sequential"] as const;

type ToolExecution = (typeof TOOL_EXECUTION)[number];

/**
 * Append what the kernel knows about the environment to what the mode says.
 *
 * This is done here rather than left to whoever writes the file, because where
 * the agent is running is not a mode's opinion — it is a fact every mode needs
 * and that a mode author has no reason to think about. A mode that forgot to
 * mention the working directory would be a mode that guesses at paths.
 *
 * Written as a suffix so the instructions read as one block with the factual
 * context trailing it, rather than interrupted mid-paragraph.
 */
export function withEnvironment(body: string, context: ProfileContext): string {
	return [
		body,
		"",
		`Working directory: ${context.cwd}`,
		`Current time: ${new Date().toISOString()}`,
	].join("\n");
}

/**
 * Parse one markdown document into a mode, or explain why it cannot be one.
 *
 * Every failure here is a hard error rather than a default, and the reason is
 * the same one the expert loader gives: a mode that loads with the wrong tool
 * set is worse than one that does not load, because nothing looks broken. The
 * tool set in particular is the security boundary of the whole design, so it
 * is required rather than inferred.
 */
export function toProfile(id: string, source: string, raw: string): AgentProfile {
	const { data, body } = parseFrontmatter(raw, source);

	const label = data.name;
	if (typeof label !== "string" || label.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "name"`);
	}

	const description = data.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "description"`);
	}

	// A mode with no body is a mode that behaves exactly like the default
	// assistant, which is indistinguishable from the file being ignored.
	if (body.length === 0) {
		throw new Error(`${source}: the body is empty, so this mode would change nothing`);
	}

	// Required, and stated in the error: the tool set is what a mode *is*, so
	// defaulting it would either over-grant (everything) or under-grant
	// (nothing), and both would be a guess about the author's intent.
	if (data.tools === undefined) {
		throw new Error(
			`${source}: frontmatter needs a "tools" list — the tool set is a mode's capability boundary, ` +
				`so it is stated rather than defaulted. Use "tools: []" for a mode that only talks.`,
		);
	}
	if (!Array.isArray(data.tools) || data.tools.some((name) => typeof name !== "string")) {
		throw new Error(`${source}: "tools" must be a list of tool names`);
	}
	const toolNames = data.tools as string[];

	// Checked at load time rather than silently dropped when the tool cannot be
	// built. An unknown name and an unavailable tool look identical from the
	// outside — "the agent did not use it" — and only one of them is the
	// author's mistake.
	const unknown = toolNames.filter((name) => !(name in TOOL_FACTORIES));
	if (unknown.length > 0) {
		throw new Error(`${source}: unknown tool(s): ${unknown.join(", ")}\n  Known tools: ${TOOL_NAMES.join(", ")}`);
	}

	let thinkingLevel: ThinkingLevel | undefined;
	if (data.thinkingLevel !== undefined) {
		if (typeof data.thinkingLevel !== "string" || !(THINKING_LEVELS as readonly string[]).includes(data.thinkingLevel)) {
			throw new Error(`${source}: "thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		thinkingLevel = data.thinkingLevel as ThinkingLevel;
	}

	let toolExecution: ToolExecution | undefined;
	if (data.toolExecution !== undefined) {
		if (typeof data.toolExecution !== "string" || !(TOOL_EXECUTION as readonly string[]).includes(data.toolExecution)) {
			throw new Error(`${source}: "toolExecution" must be one of ${TOOL_EXECUTION.join(", ")}`);
		}
		toolExecution = data.toolExecution as ToolExecution;
	}

	// A model spec is *not* validated against a catalog here, and that is
	// deliberate: the set of known models comes from the provider registry,
	// which is not readable from a pure parse function. Validating it in
	// `resolveSetup` instead means the error can name the mode *and* the file it
	// came from, which is more useful than a bare "unknown model" from here.
	// A blank string is rejected anyway — it is a typo, not a request.
	let model: string | undefined;
	if (data.model !== undefined) {
		if (typeof data.model !== "string" || data.model.trim().length === 0) {
			throw new Error(`${source}: "model" must be a non-empty "provider/modelId" string`);
		}
		model = data.model.trim();
	}

	const profile: AgentProfile = {
		id,
		label: label.trim(),
		description: description.trim(),
		// Reused for diagnostics: the same string that names the file in an
		// error is the one a listing shows, so "which file is this mode from"
		// has one answer rather than two that could disagree.
		source,
		systemPrompt: (context: ProfileContext) => withEnvironment(body, context),
		tools: (context: ProfileContext): AnyTool[] => {
			const built: AnyTool[] = [];
			for (const name of toolNames) {
				const tool = resolveTool(name, context.cwd);
				// A name the catalog knows but this build cannot construct —
				// pi's `powershell` outside Windows — drops out quietly. It is
				// not the author's mistake, and refusing to start would make a
				// cross-platform mode file impossible to write.
				if (tool) built.push(tool);
			}
			return built;
		},
	};

	// Assigned conditionally rather than as `thinkingLevel: thinkingLevel`, so
	// the key stays absent when the file expressed no opinion. Same reason as
	// the expert loader: absent and `undefined` are equivalent here, but only
	// one of them survives a `JSON.stringify` honestly.
	if (thinkingLevel) profile.thinkingLevel = thinkingLevel;
	if (toolExecution) profile.toolExecution = toolExecution;
	if (model) profile.model = model;
	return profile;
}
