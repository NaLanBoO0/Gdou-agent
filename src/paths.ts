/**
 * Filesystem layout for this project.
 *
 * The agent keeps its own state separate from pi's (`~/.pi/agent`), so the two
 * can coexist without either overwriting the other's settings or sessions.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const __GDOU_BUNDLED__: boolean | undefined;

/**
 * True when running from a bundle produced by `npm run build`, false under tsx.
 *
 * esbuild replaces the identifier at build time; under tsx it is genuinely
 * absent, which is why the check goes through `typeof`.
 */
export const IS_BUNDLED = typeof __GDOU_BUNDLED__ !== "undefined" && __GDOU_BUNDLED__ === true;

/**
 * Root of this project (contains package.json).
 *
 * Derived from this file's location, which lands in the right place in both
 * modes by construction: the bundle sits at `dist/main.mjs`, exactly one level
 * below the project root, the same depth `src/paths.ts` sits at. Once packaged,
 * `dist/` lives inside `app.asar`, so this resolves to the app root.
 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Vendored pi source tree. Override with GDOU_VENDOR_DIR if it lives elsewhere.
 *
 * Meaningful only for unbundled runs. When the agent is bundled, pi's sources
 * are compiled into the bundle and no separate tree is read at runtime, so this
 * path is reported for diagnostics but nothing depends on it existing.
 *
 * This used to point at a sibling `../pi-main` checkout. pi is now vendored into
 * `vendor/pi` (see vendor/pi/README.md), so the source travels with this repo.
 */
export const VENDOR_PI_DIR = process.env.GDOU_VENDOR_DIR
	? resolve(process.env.GDOU_VENDOR_DIR)
	: resolve(PROJECT_ROOT, "vendor", "pi");

/**
 * Where pi's sources came from, for diagnostics.
 *
 * Shared by the CLI and the GUI so the two cannot report different answers:
 * an earlier version had each format its own string, and the GUI kept claiming
 * a checkout path that a bundled run does not use.
 */
export function describePiSource(): string {
	return IS_BUNDLED ? "(inlined into the bundle)" : VENDOR_PI_DIR;
}

/** Per-user state directory for this agent. Override with GDOU_AGENT_HOME. */
export const AGENT_HOME = process.env.GDOU_AGENT_HOME
	? resolve(process.env.GDOU_AGENT_HOME)
	: join(homedir(), ".gdou-agent");

export function settingsPath(): string {
	return join(AGENT_HOME, "settings.json");
}

/**
 * The workspace registry: projects the user has opened from the shell.
 *
 * Each entry maps a workspace id (its real path) to the folder, so `workspace.open`
 * can list projects in the tree and `session.create` can point a conversation's
 * working directory at the folder it belongs to. Lives in AGENT_HOME, like
 * settings, so it survives bridge restarts.
 */
export function workspacesPath(): string {
	return join(AGENT_HOME, "workspaces.json");
}

/**
 * Where diagnostics land: crash reports, the running log, heap dumps.
 *
 * Kept under AGENT_HOME so a bundled run and a tsx run write to the same place,
 * and so `GDOU_AGENT_HOME` (used by the GUI self-check to isolate state) also
 * isolates the logs from the real user's.
 */
export function logsDir(): string {
	return join(AGENT_HOME, "logs");
}

export function notesPath(): string {
	return join(AGENT_HOME, "notes.json");
}

export function sessionsDir(): string {
	return join(AGENT_HOME, "sessions");
}

/** User-level experts: one markdown file per expert. */
export function expertsDir(): string {
	return join(AGENT_HOME, "experts");
}

/**
 * Project-level experts, resolved against a working directory.
 *
 * Project-scoped definitions live next to the code they describe, so a team
 * can version them with the repository. They take precedence over user-level
 * ones of the same id.
 */
export function projectExpertsDir(cwd: string): string {
	return join(cwd, ".gdou-agent", "experts");
}

/** User-level skills: one directory per skill, each holding a `SKILL.md`. */
export function skillsDir(): string {
	return join(AGENT_HOME, "skills");
}

/** Project-level skills, resolved against a working directory. */
export function projectSkillsDir(cwd: string): string {
	return join(cwd, ".gdou-agent", "skills");
}

/** User-level modes: one markdown file per mode. */
export function modesDir(): string {
	return join(AGENT_HOME, "modes");
}

/**
 * Project-level modes, resolved against a working directory.
 *
 * Same reasoning as `projectExpertsDir`: a repository is the natural place to
 * version "the modes this codebase is worked on with", and a checked-in
 * definition should not be shadowed by whatever the individual happens to have
 * at home.
 */
export function projectModesDir(cwd: string): string {
	return join(cwd, ".gdou-agent", "modes");
}
