/**
 * Mode registry.
 *
 * Four sources, most specific last:
 *
 *   built-in    (shipped, in `builtin.ts`, parsed from inline markdown)
 *   user        (`~/.gdou-agent/modes/<id>.md`)
 *   project     (`<cwd>/.gdou-agent/modes/<id>.md`)
 *   registered  (in-process, via `registerProfile`)
 *
 * Project-level wins over user-level of the same id, so a team can version the
 * modes a codebase is worked on with without them being shadowed by whatever
 * the individual happens to have at home. Registered profiles win over
 * everything: they are not a user extension point but the embedding seam, and
 * code running in this process is the most specific intent there is.
 *
 * Nothing is cached. A session is created rarely, reading a directory is cheap,
 * and a cache here would mean an edited mode silently not taking effect until
 * the app restarts — which is exactly the sort of thing that is hard to notice
 * and easy to blame on the model.
 */

import { loadDefinitionDir } from "../definitions/directory.ts";
import { modesDir, projectModesDir } from "../paths.ts";
import { BUILTIN_MODES } from "./builtin.ts";
import { toProfile } from "./loader.ts";
import type { AgentProfile } from "./types.ts";

/** Id used when nothing is configured. */
export const FALLBACK_PROFILE_ID = "general";

/**
 * Modes a host application has supplied in code.
 *
 * Kept apart from the loaded ones rather than merged into the same map, so
 * `loadProfiles` stays a pure read and re-registering an id is idempotent
 * instead of an error. An embedding host that rebuilds its modes after a hot
 * reload should not have to unregister first.
 */
const registered = new Map<string, AgentProfile>();

/** Supply (or replace) a mode built in code. Merged last, so it wins. */
export function registerProfile(profile: AgentProfile): void {
	registered.set(profile.id, profile);
}

/** Parse the shipped modes. A failure here is a bug in this repo, not user error. */
function loadBuiltins(): AgentProfile[] {
	return BUILTIN_MODES.map((entry) => toProfile(entry.id, `(built-in) ${entry.id}`, entry.source));
}

export interface ProfileCatalog {
	/** Every known mode. Later sources have overwritten earlier ones. */
	profiles: AgentProfile[];
	/** Files that exist but could not be loaded, with the reason. */
	errors: string[];
}

export interface ProfileLoadOptions {
	/** Working directory, used to find project-level modes. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Override the user-level directory. Defaults to `~/.gdou-agent/modes`.
	 *
	 * Exists so a test can resolve a catalog without reading — or depending on
	 * the absence of — the real user's files. Without it, "we ship two modes"
	 * would stop being true for anyone who has written a third.
	 */
	userDir?: string;
}

/**
 * Order the catalog: the shipped modes in their declared order, then anything
 * else by id.
 *
 * Not a plain id sort, which is what experts use. Modes have a default: the
 * startup picker highlights the first entry on a fresh install, so the order
 * decides which mode a first-time user gets. Sorting alphabetically would put
 * `coding` — the one with shell access — under the cursor. Shipped modes keep
 * their declared order so that default stays the safe one, and a user's own
 * modes follow.
 */
function order(byId: Map<string, AgentProfile>): AgentProfile[] {
	const shipped = BUILTIN_MODES.map((entry) => entry.id);
	const shippedSet = new Set(shipped);
	const rest = [...byId.keys()].filter((id) => !shippedSet.has(id)).sort((a, b) => a.localeCompare(b));
	return [...shipped, ...rest].flatMap((id) => {
		const profile = byId.get(id);
		return profile ? [profile] : [];
	});
}

/** Resolve the catalog for a working directory. */
export function loadProfiles(options: ProfileLoadOptions = {}): ProfileCatalog {
	const cwd = options.cwd ?? process.cwd();
	const byId = new Map<string, AgentProfile>();
	const errors: string[] = [];

	for (const profile of loadBuiltins()) byId.set(profile.id, profile);

	const dirs = [options.userDir ?? modesDir(), projectModesDir(cwd)];
	for (const dir of dirs) {
		const loaded = loadDefinitionDir(dir, toProfile);
		errors.push(...loaded.errors);
		for (const profile of loaded.items) byId.set(profile.id, profile);
	}

	for (const profile of registered.values()) byId.set(profile.id, profile);

	return { profiles: order(byId), errors };
}

export function listProfiles(cwd?: string): AgentProfile[] {
	return loadProfiles({ cwd }).profiles;
}

export function hasProfile(id: string, cwd?: string): boolean {
	return listProfiles(cwd).some((profile) => profile.id === id);
}

/**
 * Look one mode up in an already-loaded catalog.
 *
 * Separated from `getProfile` so the error message has exactly one
 * implementation while still being checkable against a controlled catalog —
 * `getProfile` resolves the real directories, which a test must not depend on.
 */
export function requireProfile(catalog: ProfileCatalog, id: string): AgentProfile {
	const profile = catalog.profiles.find((entry) => entry.id === id);
	if (!profile) {
		const known = catalog.profiles.map((entry) => entry.id).join(", ");
		// The load errors ride along: "unknown mode" next to a file that failed
		// to parse is two facts that explain each other, and reporting only the
		// first sends the user looking for a typo in an id that is spelled right.
		const broken =
			catalog.errors.length > 0 ? `\nSome mode files could not be loaded:\n  ${catalog.errors.join("\n  ")}` : "";
		throw new Error(`Unknown mode: ${id}. Available: ${known}${broken}`);
	}
	return profile;
}

export function getProfile(id: string, cwd?: string): AgentProfile {
	return requireProfile(loadProfiles({ cwd }), id);
}
