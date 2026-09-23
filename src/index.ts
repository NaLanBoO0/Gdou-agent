/**
 * Public API.
 *
 * A front-end (CLI, TUI, HTTP service) should import from here and nowhere else,
 * so the internal layout can change without breaking consumers.
 */

// Kernel
export { createAgent, type AgentSession, type CreateAgentOptions } from "./kernel/agent.ts";
export { composePrompt, narrowTools, type RecipeRequest, type SessionRecipe, type ToolSelection } from "./kernel/recipe.ts";
export { ModelRuntime, parseModelSpec, type ParsedSpec } from "./kernel/runtime.ts";
export { toolchainPaths, type ToolchainPaths } from "./kernel/toolchain.ts";
export { translate, replay, blocksToText, type AgentEvent, type AgentEventListener } from "./kernel/events.ts";
export { CONTEXT_BUDGET_CHARS, contextReport, pruneForContext } from "./kernel/context.ts";
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

// Profiles
export { getProfile, hasProfile, listProfiles, registerProfile, FALLBACK_PROFILE_ID } from "./profiles/registry.ts";
export type { AgentProfile, AnyTool, ProfileContext } from "./profiles/types.ts";
export { createCodingProfile, CODING_TOOL_NAMES, DEFAULT_CODING_TOOLS } from "./profiles/coding.ts";
export { generalProfile } from "./profiles/general.ts";

// Experts
export { getExpert, hasExpert, listExperts, loadExperts, type ExpertCatalog } from "./experts/registry.ts";
export { parseFrontmatter, type Frontmatter } from "./experts/frontmatter.ts";
export type { Expert, ExpertDraft } from "./experts/types.ts";

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
