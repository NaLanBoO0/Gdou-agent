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

/**
 * One saved model profile, as the shell's model manager stores it.
 *
 * Deliberately thin: a profile names a model spec the catalog already knows.
 * Everything else the shell's editor collects (API addresses, sampling knobs)
 * describes a runtime it would have to talk to on its own; what *we* can store
 * and reuse is the spec, so that is all a profile is.
 */
export interface ModelProfile {
	/** Stable id, chosen by the caller (the shell reuses it on edit). */
	id: string;
	/** Display name. */
	name: string;
	/** Model spec as "provider/modelId". */
	model: string;
}

export interface Settings {
	/** Default model as "provider/modelId". */
	model?: string;
	/** Named model profiles shown in the shell's model manager. */
	modelProfiles?: ModelProfile[];
	/** Skill ids the user has turned off; those are hidden from the catalog. */
	disabledSkills?: string[];
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
	/**
	 * Model to retry on when the primary one fails before producing any output.
	 *
	 * A spec like "deepseek/deepseek-flash". Only used for a failure that
	 * happened *before* anything was streamed — switching models halfway through
	 * a reply would either duplicate or discard what the user already saw.
	 */
	fallbackModel?: string;
	/**
	 * How many consecutive identical tool calls are allowed before the agent
	 * refuses the next one. `0` disables the check.
	 *
	 * Exposed because the rule is deliberately blunt: a workflow that legitimately
	 * polls the same command with the same arguments will trip it, and raising the
	 * number has to be possible without editing source.
	 */
	loopRepeatLimit?: number;
	/**
	 * The shell's approval mode: "auto" lets every tool call through without
	 * asking; any other value routes out-of-workspace `ask` decisions to the
	 * shell for a human decision. A shell concept, kept in settings so the
	 * bridge honors it when it builds a session.
	 */
	permissionMode?: "normal" | "accept_edits" | "plan" | "auto";
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
	if (typeof input.fallbackModel === "string" && input.fallbackModel.trim().length > 0) {
		settings.fallbackModel = input.fallbackModel;
	}
	if (typeof input.permissionMode === "string" && (["normal", "accept_edits", "plan", "auto"] as string[]).includes(input.permissionMode)) {
		settings.permissionMode = input.permissionMode as "normal" | "accept_edits" | "plan" | "auto";
	}
	// `Number.isInteger` rather than a truthiness check: `0` is meaningful here
	// (it disables the guard) and would be dropped by the usual `if (input.x)`
	// shape, silently turning "off" into "default".
	if (typeof input.loopRepeatLimit === "number" && Number.isInteger(input.loopRepeatLimit) && input.loopRepeatLimit >= 0) {
		settings.loopRepeatLimit = input.loopRepeatLimit;
	}
	// Model profiles are validated entry by entry. A profile naming a model spec
	// that no longer resolves is kept — resolution happens at use time and the
	// message that names the bad spec is more useful than silently dropping it.
	const profiles = Array.isArray(input.modelProfiles) ? (input.modelProfiles as unknown[]) : [];
	const parsedProfiles: ModelProfile[] = [];
	for (const entry of profiles) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.model !== "string") continue;
		if (raw.id.length === 0 || raw.model.length === 0) continue;
		parsedProfiles.push({ id: raw.id, name: raw.name, model: raw.model });
	}
	if (parsedProfiles.length > 0) settings.modelProfiles = parsedProfiles;
	// Disabled skills are just ids; anything that is not a string is dropped.
	const disabled = Array.isArray(input.disabledSkills) ? (input.disabledSkills as unknown[]) : [];
	const parsedDisabled = disabled.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (parsedDisabled.length > 0) settings.disabledSkills = parsedDisabled;
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
