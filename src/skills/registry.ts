/**
 * Skill registry.
 *
 * A skill is a *directory* containing a `SKILL.md`, unlike a mode or an expert
 * which are single files. The directory exists because a skill may carry
 * reference material — additional files the agent loads on demand, kept out of
 * the main body so loading a skill does not drag in everything it might
 * eventually need.
 *
 * Three sources, most specific last, exactly like experts and modes:
 *
 *   built-in (shipped, in `builtin.ts`)
 *   user     (`~/.gdou-agent/skills/<id>/SKILL.md`)
 *   project  (`<cwd>/.gdou-agent/skills/<id>/SKILL.md`)
 *
 * A project-level skill of the same id overwrites the user-level one.
 *
 * Nothing is cached, for the same reason the expert registry does not cache:
 * a session is created rarely, reading a directory is cheap, and a cache would
 * mean an edited skill silently not taking effect until restart.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "../definitions/frontmatter.ts";
import { projectSkillsDir, skillsDir } from "../paths.ts";
import { BUILTIN_SKILLS } from "./builtin.ts";
import type { Skill, SkillDraft, SkillReference } from "./types.ts";

const SKILL_FILE = "SKILL.md";
const REFERENCES_DIR = "references";

/**
 * Parse a SKILL.md body into a Skill.
 *
 * `raw` is the markdown text, `source` is what a diagnostics line shows (the
 * SKILL.md path for file-backed skills, `(built-in) <id>` for shipped ones).
 * References are resolved by the caller and passed in — built-ins have none.
 */
function parseSkillMarkdown(id: string, raw: string, source: string, references: SkillReference[]): Skill {
	const { data, body } = parseFrontmatter(raw, source);

	const label = data.name;
	if (typeof label !== "string" || label.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "name"`);
	}

	const description = data.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw new Error(`${source}: frontmatter needs a non-empty "description"`);
	}

	// `when_to_use` is what makes progressive disclosure work: it is the routing
	// hint the model sees *before* the body is loaded. Optional, because not every
	// skill needs a trigger phrase — some are invoked by the model's own judgment.
	let whenToUse = "";
	if (data.when_to_use !== undefined) {
		if (typeof data.when_to_use !== "string") {
			throw new Error(`${source}: "when_to_use" must be a string`);
		}
		whenToUse = data.when_to_use.trim();
	}

	if (body.length === 0) {
		throw new Error(`${source}: the body is empty, so this skill would change nothing when loaded`);
	}

	return {
		id,
		label: label.trim(),
		description: description.trim(),
		whenToUse,
		body,
		references,
		source,
	};
}

/**
 * Load one file-backed skill from its directory.
 *
 * The `path` is the directory; `source` is the `SKILL.md` path, because that is
 * the file a user opens to fix a problem.
 */
function toFileSkill(id: string, path: string, source: string): Skill {
	let raw: string;
	try {
		raw = readFileSync(join(path, SKILL_FILE), "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(`${source}: no ${SKILL_FILE} (${code === "ENOENT" ? "missing" : (error as Error).message})`);
	}
	return parseSkillMarkdown(id, raw, source, readReferences(path));
}

/**
 * Read the `references/` directory, one entry per file.
 *
 * A reference file is described by a sibling `*.txt` note when one exists, so
 * the agent can decide whether to read it without the note being part of the
 * file itself. When there is no note, the description is just the filename —
 * still useful, because the filename is usually enough to route.
 */
function readReferences(path: string): SkillReference[] {
	const dir = join(path, REFERENCES_DIR);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	const references: SkillReference[] = [];
	for (const name of names.sort()) {
		const file = join(dir, name);
		try {
			if (!statSync(file).isFile()) continue;
		} catch {
			continue;
		}
		// The note file describes its sibling, it is not itself a reference.
		if (name.endsWith(".txt") || name.endsWith(".md.note")) continue;

		let description = name;
		const notePath = `${file}.note`;
		try {
			description = readFileSync(notePath, "utf-8").trim() || name;
		} catch {
			// No note: the filename stands in.
		}
		references.push({ name, description });
	}
	return references;
}

/** Parse the shipped skills. A failure here is a bug in this repo, not user error. */
function loadBuiltins(): Skill[] {
	return BUILTIN_SKILLS.map((entry) =>
		parseSkillMarkdown(entry.id, entry.source, `(built-in) ${entry.id}`, []),
	);
}

/**
 * The directory a skill's references live in, keyed by id for the given cwd.
 *
 * Built-ins have no directory — their `references` list is empty and this is
 * never consulted for them. File-backed skills resolve the directory from the
 * path the loader walked, which is the only place the mapping is known.
 */
function referenceDir(skill: Skill, cwd: string): string | undefined {
	// A built-in has a synthetic source, not a path.
	if (skill.source.startsWith("(built-in)")) return undefined;
	return dirname(skill.source);
}

/**
 * Read every skill directory under `dir`.
 *
 * The directory-missing policy is "empty", matching `loadDefinitionDir`: most
 * users have no skills directory, and that is normal, not an error. A directory
 * that exists but holds a broken skill is reported and the rest still load.
 */
function loadDir(dir: string): { skills: Skill[]; errors: string[] } {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { skills: [], errors: [] };
	}

	const skills: Skill[] = [];
	const errors: string[] = [];
	for (const name of names.sort()) {
		const path = join(dir, name);
		try {
			// A skill is a directory. Flat files are ignored, so stray READMEs or
			// notes in the skills directory do not become phantom skills.
			if (!statSync(path).isDirectory()) continue;
		} catch {
			continue;
		}
		try {
			skills.push(toFileSkill(basename(name), path, join(path, SKILL_FILE)));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { skills, errors };
}

export interface SkillCatalog {
	/** Every known skill, sorted by id. Later sources have overwritten earlier. */
	skills: Skill[];
	/** Directories that exist but could not be loaded, with the reason. */
	errors: string[];
}

/**
 * Resolve the catalog for a working directory. Loaded on demand, never cached.
 *
 * `disabled` names skill ids the user has turned off. They are hidden from the
 * catalog — which is what a session's prompt sees and what the skill lists
 * show — but `getSkill` can still resolve them, so an explicit `load_skill`
 * request stays able to read a disabled skill's body. "Disabled" means "stop
 * suggesting it", not "forget it exists".
 */
export function loadSkills(cwd: string, disabled?: ReadonlySet<string>): SkillCatalog {
	const byId = new Map<string, Skill>();
	const errors: string[] = [];

	for (const skill of loadBuiltins()) byId.set(skill.id, skill);

	for (const dir of [skillsDir(), projectSkillsDir(cwd)]) {
		const loaded = loadDir(dir);
		errors.push(...loaded.errors);
		for (const skill of loaded.skills) byId.set(skill.id, skill);
	}

	let skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	if (disabled && disabled.size > 0) skills = skills.filter((skill) => !disabled.has(skill.id));
	return { skills, errors };
}

export function listSkills(cwd: string, disabled?: ReadonlySet<string>): Skill[] {
	return loadSkills(cwd, disabled).skills;
}

export function getSkill(id: string, cwd: string): Skill {
	const catalog = loadSkills(cwd);
	const skill = catalog.skills.find((entry) => entry.id === id);
	if (!skill) {
		const known = catalog.skills.map((entry) => entry.id).join(", ");
		const broken = catalog.errors.length > 0 ? `\nSome skill directories could not be loaded:\n  ${catalog.errors.join("\n  ")}` : "";
		throw new Error(`Unknown skill: ${id}. Available: ${known}${broken}`);
	}
	return skill;
}

/** Read one reference file of a skill, or throw when it does not exist. */
export function readSkillReference(skill: Skill, cwd: string, name: string): string {
	const reference = skill.references.find((entry) => entry.name === name);
	if (!reference) {
		const known = skill.references.map((entry) => entry.name).join(", ");
		throw new Error(`Skill "${skill.id}" has no reference "${name}". Available: ${known || "none"}`);
	}
	const dir = referenceDir(skill, cwd);
	if (!dir) {
		throw new Error(`Skill "${skill.id}" is built in and its references are not readable as files.`);
	}
	return readFileSync(join(dir, REFERENCES_DIR, name), "utf-8");
}

/**
 * Copy a skill directory into the user or project skills directory.
 *
 * `source` must be a directory containing a parseable `SKILL.md`; the skill's
 * id is the directory name. The install refuses to overwrite: an id that
 * already has a directory there means a human decided something about it, and
 * overwriting silently is how edits get lost.
 *
 * `scope` selects the target: `"workspace"` puts it under `<cwd>/.gdou-agent/skills/`
 * (versioned with the repository), anything else under `~/.gdou-agent/skills/`.
 */
export function installSkill(source: string, scope: string, cwd: string): Skill {
	const sourceDir = resolve(source);
	const id = basename(sourceDir);
	if (id.length === 0 || id === ".") throw new Error("技能目录名不能为空");

	// Validate *before* copying: the parse throws for a broken frontmatter, an
	// empty body, or a missing SKILL.md — all the reasons the installed skill
	// would be reported as an error the moment it loaded.
	const sourceSkill = toFileSkill(id, sourceDir, join(sourceDir, SKILL_FILE));

	const target = scope === "workspace" ? join(projectSkillsDir(cwd), id) : join(skillsDir(), id);
	if (existsSync(target)) {
		throw new Error(`技能 ${id} 已存在于 ${target}，先卸载再安装。`);
	}
	mkdirSync(dirname(target), { recursive: true });
	cpSync(sourceDir, target, { recursive: true });
	return sourceSkill;
}

/**
 * Remove an installed skill by id.
 *
 * Built-in skills cannot be removed — their bodies ship with this repository,
 * so "uninstalling" one would have to mean editing source. Everything else
 * resolves the installed directory from the catalog and deletes it; a skill
 * that is not in the catalog at all is reported rather than guessed at.
 */
export function uninstallSkill(id: string, cwd: string): void {
	const catalog = loadSkills(cwd);
	const skill = catalog.skills.find((entry) => entry.id === id);
	if (!skill) throw new Error(`未知技能：${id}`);
	if (skill.source.startsWith("(built-in)")) throw new Error("内置技能不能卸载");
	const dir = dirname(skill.source);
	rmSync(dir, { recursive: true, force: true });
}
