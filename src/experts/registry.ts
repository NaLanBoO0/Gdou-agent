/**
 * Expert registry.
 *
 * Three sources, most specific last:
 *
 *   built-in (shipped, in `builtin.ts`)
 *   user     (`~/.gdou-agent/experts/<id>.md`)
 *   project  (`<cwd>/.gdou-agent/experts/<id>.md`)
 *
 * Project-level wins over user-level of the same id, so a team can version a
 * definition alongside the code it describes without it being shadowed by
 * whatever the individual happened to have in their home directory.
 *
 * Nothing is cached. A session is created rarely, reading a directory is cheap,
 * and a cache here would mean an edited expert silently not taking effect until
 * the app restarts — which is exactly the sort of thing that is hard to notice
 * and easy to blame on the model.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../config/settings.ts";
import { expertsDir, projectExpertsDir } from "../paths.ts";
import { BUILTIN_EXPERTS } from "./builtin.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import type { Expert } from "./types.ts";

const MARKDOWN = ".md";

/** Turn one markdown document into an expert, or explain why it cannot be one. */
function toExpert(id: string, source: string, raw: string): Expert {
	const { data, body } = parseFrontmatter(raw, source);

	const label = data.name;
	if (typeof label !== "string" || label.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "name"`);
	}

	// Required rather than defaulted: the description is what a picker shows, so
	// an expert without one is a blank row in the UI with no way to tell what it
	// does. Failing at load time costs one line to fix; a blank row costs
	// indefinitely.
	const description = data.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "description"`);
	}

	// An expert is its methodology. Without a body it would compose into a
	// session that behaves identically to no expert at all, which is worse than
	// an error because nothing looks wrong.
	if (body.length === 0) {
		throw new Error(`${source}: the body is empty, so this expert would change nothing`);
	}

	let tools: string[] | undefined;
	if (data.tools !== undefined) {
		if (!Array.isArray(data.tools) || data.tools.some((name) => typeof name !== "string")) {
			throw new Error(`${source}: "tools" must be a list of tool names`);
		}
		tools = data.tools as string[];
	}

	let thinkingLevel: ThinkingLevel | undefined;
	if (data.thinkingLevel !== undefined) {
		if (
			typeof data.thinkingLevel !== "string" ||
			!(THINKING_LEVELS as readonly string[]).includes(data.thinkingLevel)
		) {
			throw new Error(`${source}: "thinkingLevel" must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		thinkingLevel = data.thinkingLevel as ThinkingLevel;
	}

	const expert: Expert = { id, label: label.trim(), description: description.trim(), methodology: body, source };
	// Assigned conditionally rather than as `tools: tools`: with
	// `exactOptionalPropertyTypes` off these are equivalent, but keeping the key
	// absent matches "no opinion" and keeps a `JSON.stringify` honest.
	if (tools) expert.tools = tools;
	if (thinkingLevel) expert.thinkingLevel = thinkingLevel;
	return expert;
}

/** Parse the shipped experts. A failure here is a bug in this repo, not user error. */
function loadBuiltins(): Expert[] {
	return BUILTIN_EXPERTS.map((entry) => toExpert(entry.id, `(built-in) ${entry.id}`, entry.source));
}

/**
 * Read every `*.md` in a directory.
 *
 * A directory that does not exist is normal — most users have no project-level
 * experts — so it yields nothing rather than erroring. A file that exists but
 * does not parse is collected as an error instead of being skipped: a silently
 * ignored expert is indistinguishable from a typo in the id.
 */
function loadDir(dir: string): { experts: Expert[]; errors: string[] } {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { experts: [], errors: [] };
	}

	const experts: Expert[] = [];
	const errors: string[] = [];
	for (const name of names.sort()) {
		if (extname(name).toLowerCase() !== MARKDOWN) continue;
		const path = join(dir, name);
		try {
			if (!statSync(path).isFile()) continue;
			experts.push(toExpert(basename(name, extname(name)), path, readFileSync(path, "utf-8")));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { experts, errors };
}

export interface ExpertCatalog {
	/** Every known expert, sorted by id. Later sources have overwritten earlier. */
	experts: Expert[];
	/** Files that exist but could not be loaded, with the reason. */
	errors: string[];
}

/**
 * Resolve the catalog for a working directory.
 *
 * Loaded on demand rather than cached, so an edited file takes effect on the
 * next session without restarting anything.
 */
export function loadExperts(cwd: string): ExpertCatalog {
	const byId = new Map<string, Expert>();
	const errors: string[] = [];

	for (const expert of loadBuiltins()) byId.set(expert.id, expert);

	for (const dir of [expertsDir(), projectExpertsDir(cwd)]) {
		const loaded = loadDir(dir);
		errors.push(...loaded.errors);
		for (const expert of loaded.experts) byId.set(expert.id, expert);
	}

	return { experts: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), errors };
}

export function listExperts(cwd: string): Expert[] {
	return loadExperts(cwd).experts;
}

export function hasExpert(id: string, cwd: string): boolean {
	return listExperts(cwd).some((expert) => expert.id === id);
}

export function getExpert(id: string, cwd: string): Expert {
	const catalog = loadExperts(cwd);
	const expert = catalog.experts.find((entry) => entry.id === id);
	if (!expert) {
		const known = catalog.experts.map((entry) => entry.id).join(", ");
		const broken = catalog.errors.length > 0 ? `\nSome files could not be loaded:\n  ${catalog.errors.join("\n  ")}` : "";
		throw new Error(`Unknown expert: ${id}. Available: ${known}${broken}`);
	}
	return expert;
}
