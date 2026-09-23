/**
 * Profile registry.
 *
 * Profiles are looked up by id. Built-ins are registered at module load;
 * additional profiles can be registered before the first agent is created.
 */

import { createCodingProfile } from "./coding.ts";
import { generalProfile } from "./general.ts";
import type { AgentProfile } from "./types.ts";

const registry = new Map<string, AgentProfile>();

export function registerProfile(profile: AgentProfile): void {
	if (registry.has(profile.id)) {
		throw new Error(`Profile already registered: ${profile.id}`);
	}
	registry.set(profile.id, profile);
}

export function getProfile(id: string): AgentProfile {
	const profile = registry.get(id);
	if (!profile) {
		const known = listProfiles()
			.map((entry) => entry.id)
			.join(", ");
		throw new Error(`Unknown profile: ${id}. Available: ${known}`);
	}
	return profile;
}

export function hasProfile(id: string): boolean {
	return registry.has(id);
}

export function listProfiles(): AgentProfile[] {
	return [...registry.values()];
}

/** Id used when nothing is configured. */
export const FALLBACK_PROFILE_ID = "general";

registerProfile(generalProfile);
registerProfile(createCodingProfile());
