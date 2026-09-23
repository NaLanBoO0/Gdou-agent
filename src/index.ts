/**
 * Public API.
 *
 * A front-end (CLI, TUI, HTTP service) should import from here and nowhere else,
 * so the internal layout can change without breaking consumers.
 */

// Kernel
export {
	createAgent,
	defaultStreamFn,
	type AgentSession,
	type CreateAgentOptions,
	type PermissionDenial,
	type StreamFnOptions,
} from "./kernel/agent.ts";
export { composePrompt, narrowTools, type RecipeRequest, type SessionRecipe, type ToolSelection } from "./kernel/recipe.ts";
export { ModelRuntime, parseModelSpec, type ParsedSpec } from "./kernel/runtime.ts";
export {
	authPath,
	credentialStore,
	FileCredentialStore,
	providerCredentials,
	removeApiKey,
	setApiKey,
	type ProviderCredential,
} from "./kernel/credentials.ts";
export { toolchainPaths, type ToolchainPaths } from "./kernel/toolchain.ts";
export { translate, replay, blocksToText, type AgentEvent, type AgentEventListener } from "./kernel/events.ts";
export { CONTEXT_BUDGET_CHARS, contextReport, pruneForContext } from "./kernel/context.ts";
export { withModelFallback, describeModel, type FallbackReport, type ModelFallbackOptions } from "./kernel/fallback.ts";
export { appLogPath, armMemoryWatch, logLine, writeCrashRecord } from "./kernel/observability.ts";
export {
	LoopGuard,
	callKey,
	loopBlockReason,
	DEFAULT_LOOP_REPEAT_LIMIT,
	type LoopDecision,
} from "./kernel/loop-guard.ts";
export {
	createSessionId,
	deleteSession,
	listSessions,
	loadSession,
	matchesRecipe,
	migrateLegacySessions,
	renameSession,
	saveSession,
	titleOf,
	type SessionDraft,
	type SessionSummary,
	type StoredSession,
} from "./kernel/sessions.ts";

// Modes (still spelled "profile" throughout the code and the file layout; the
// concept the UI, the recipe, and settings call a mode).
export {
	getProfile,
	hasProfile,
	listProfiles,
	loadProfiles,
	registerProfile,
	requireProfile,
	FALLBACK_PROFILE_ID,
	type ProfileCatalog,
	type ProfileLoadOptions,
} from "./profiles/registry.ts";
export type { AgentProfile, AnyTool, ProfileContext } from "./profiles/types.ts";
export { toProfile, withEnvironment } from "./profiles/loader.ts";
export { BUILTIN_MODES } from "./profiles/builtin.ts";
export { TOOL_NAMES, TOOL_FACTORIES, resolveTool, type ToolFactory } from "./profiles/tool-catalog.ts";

// Experts
export { getExpert, hasExpert, listExperts, loadExperts, type ExpertCatalog } from "./experts/registry.ts";
export type { Expert, ExpertDraft } from "./experts/types.ts";

// Skills (progressive disclosure)
export { getSkill, listSkills, loadSkills, readSkillReference, type SkillCatalog } from "./skills/registry.ts";
export type { Skill, SkillDraft, SkillReference } from "./skills/types.ts";
export { loadSkillTool } from "./tools/load-skill.ts";
export { delegateTool } from "./tools/delegate.ts";

// Markdown-backed definitions, shared by modes and experts
export { parseFrontmatter, type Frontmatter } from "./definitions/frontmatter.ts";
export { loadDefinitionDir, type DirectoryLoad } from "./definitions/directory.ts";

// Config
export { loadSettings, saveSettings, DEFAULT_SETTINGS, THINKING_LEVELS, type Settings } from "./config/settings.ts";
export {
	PROVIDER_PRESETS,
	findPreset,
	presetsWithCredentials,
	defaultModelSpec,
	type ProviderPreset,
} from "./config/providers.ts";

// Paths
export { AGENT_HOME, describePiSource, IS_BUNDLED, PROJECT_ROOT, VENDOR_PI_DIR } from "./paths.ts";

// Tools (for reuse in custom profiles)
export { currentTimeTool } from "./tools/time.ts";
export { saveNoteTool, listNotesTool } from "./tools/notes.ts";

// Front-ends
export { canRunTui, runTui, type RunTuiOptions } from "./tui/index.ts";
export { TuiApp, type TuiAppOptions } from "./tui/app.ts";
export { createTheme, detectColors, detectThemeMode, type ThemeMode, type TuiTheme } from "./tui/theme.ts";
