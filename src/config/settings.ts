/**
 * Settings persistence.
 *
 * Stored as JSON at AGENT_HOME/settings.json. Read once at startup; writes go
 * through `saveSettings` so a partial file never lands on disk.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { APPROVAL_POLICIES, type ApprovalPolicy, type PermissionPolicy, SANDBOX_TIERS, type SandboxTier } from "../kernel/permission.ts";
import { settingsPath } from "../paths.ts";

/**
 * The thinking levels pi accepts, listed so a stored value can be validated.
 *
 * Typed against pi's union rather than restated as strings: if pi removes a
 * level this stops compiling, which is the failure worth catching. Adding one
 * upstream would not be caught here, so an unknown value is dropped rather than
 * passed through to the model layer.
 *
 * Exported because experts validate their own `thinkingLevel` against the same
 * list. A second copy would be a second thing to forget to update.
 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface Settings {
	/** Default model as "provider/modelId". */
	model?: string;
	/**
	 * Default mode id (implemented in `src/profiles`).
	 *
	 * Named `mode` rather than `profile` to match the vocabulary the recipe uses:
	 * a session is a mode plus an expert, and calling the capability layer a
	 * "profile" next to "expert" reads as two personas when only one of them is.
	 */
	mode?: string;
	/**
	 * Default expert id (see src/experts).
	 *
	 * Not validated against the registry on load: experts are files, and a
	 * user-level expert can be added or removed independently of this file.
	 * Resolving it at session start is what reports an unknown id, with the list
	 * of ones that do exist.
	 */
	expert?: string;
	/** Thinking level passed to the model. */
	thinkingLevel?: ThinkingLevel;
	/** Working directory for coding tools. Defaults to process.cwd(). */
	cwd?: string;
	/** Tool execution strategy. */
	toolExecution?: "parallel" | "sequential";
	/**
	 * Filesystem access policy for tool calls.
	 *
	 * The credential rules and the command guard are not configurable here —
	 * they hold at every tier. What this changes is how far outside the working
	 * directory the agent may reach.
	 */
	permission?: PermissionPolicy;
}

export const DEFAULT_SETTINGS: Settings = {
	mode: "general",
	thinkingLevel: "off",
	toolExecution: "parallel",
	permission: { tier: "workspace-write", approval: "ask" },
};

export function loadSettings(): Settings {
	const path = settingsPath();
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_SETTINGS };
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Expected a JSON object in ${path}`);
	}

	// Unknown keys are dropped rather than merged, so a stale key cannot silently
	// take effect after the schema changes.
	const input = parsed as Record<string, unknown>;
	const settings: Settings = { ...DEFAULT_SETTINGS };
	if (typeof input.model === "string") settings.model = input.model;
	// `profile` was this field's name before the recipe vocabulary settled on
	// `mode`. Still read as a fallback so an existing settings.json keeps
	// working rather than silently reverting to the default mode — the
	// unknown-key rule below would otherwise drop it without a word.
	const mode = typeof input.mode === "string" ? input.mode : input.profile;
	if (typeof mode === "string") settings.mode = mode;
	if (typeof input.expert === "string") settings.expert = input.expert;
	if (typeof input.thinkingLevel === "string" && (THINKING_LEVELS as readonly string[]).includes(input.thinkingLevel)) {
		settings.thinkingLevel = input.thinkingLevel as ThinkingLevel;
	}
	if (typeof input.cwd === "string") settings.cwd = input.cwd;
	if (input.toolExecution === "parallel" || input.toolExecution === "sequential") {
		settings.toolExecution = input.toolExecution;
	}
	// Validated field by field against the exported lists rather than cast, so a
	// hand-edited file naming a tier that does not exist falls back to the
	// default instead of reaching the gate as an unrecognised string.
	if (typeof input.permission === "object" && input.permission !== null) {
		const raw = input.permission as Record<string, unknown>;
		const tier = (SANDBOX_TIERS as readonly string[]).includes(raw.tier as string)
			? (raw.tier as SandboxTier)
			: DEFAULT_SETTINGS.permission?.tier;
		const approval = (APPROVAL_POLICIES as readonly string[]).includes(raw.approval as string)
			? (raw.approval as ApprovalPolicy)
			: DEFAULT_SETTINGS.permission?.approval;
		if (tier !== undefined && approval !== undefined) settings.permission = { tier, approval };
	}
	return settings;
}

export function saveSettings(settings: Settings): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
	renameSync(temp, path);
}
