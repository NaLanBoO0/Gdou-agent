/**
 * Provider presets.
 *
 * pi-ai already ships 41 providers with auth that reads the right environment
 * variables. This module is a thin layer on top that records which ones we care
 * about, what env var each needs, and a sensible default model, so the CLI and
 * the settings file can talk about "deepseek" instead of "openai-completions".
 */

/** Providers we surface in the CLI, in the order they are offered. */
export interface ProviderPreset {
	/** pi-ai provider id. */
	id: string;
	/** Human label shown in the CLI. */
	label: string;
	/** Environment variable pi-ai reads for the API key. */
	envVar: string;
	/** Default model id used when the user does not pick one. */
	defaultModel: string;
	/** Alternative model ids worth mentioning. */
	models: string[];
	/** Region hint for providers that have separate .cn endpoints. */
	region?: "cn" | "global";
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		envVar: "DEEPSEEK_API_KEY",
		defaultModel: "deepseek-flash",
		models: ["deepseek-flash", "deepseek-v4-pro"],
		region: "cn",
	},
	{
		id: "moonshotai",
		label: "Moonshot / Kimi",
		envVar: "MOONSHOT_API_KEY",
		defaultModel: "kimi-k3",
		models: ["kimi-k3", "kimi-k2.6", "kimi-k2.7-code"],
		region: "cn",
	},
	{
		id: "zai",
		label: "Zhipu GLM",
		envVar: "ZAI_API_KEY",
		defaultModel: "glm-5.3",
		models: ["glm-5.3", "glm-5.3-flash", "glm-4.7"],
		region: "cn",
	},
	{
		id: "qwen-token-plan",
		label: "Qwen",
		envVar: "QWEN_TOKEN_PLAN_API_KEY",
		defaultModel: "qwen3.8-max",
		models: ["qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash"],
		region: "cn",
	},
	{
		id: "minimax",
		label: "MiniMax",
		envVar: "MINIMAX_API_KEY",
		defaultModel: "MiniMax-M3",
		models: ["MiniMax-M3", "MiniMax-M2.7"],
		region: "cn",
	},
];

export function findPreset(id: string): ProviderPreset | undefined {
	return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Whether an environment variable holds a usable value. */
function present(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/** A preset whose API key is present in the environment. */
export function presetsWithCredentials(env: NodeJS.ProcessEnv = process.env): ProviderPreset[] {
	return PROVIDER_PRESETS.filter((preset) => present(env[preset.envVar]));
}

/**
 * Pick a default model spec ("provider/model") from what is configured.
 * Prefers presets in declared order so DeepSeek wins when several are set.
 *
 * `alsoConfigured` carries preset ids that have a credential somewhere other
 * than the environment — currently a key stored through the interface. It is a
 * parameter rather than a lookup so this module keeps knowing nothing about
 * where credentials live; passing it is what stops a key entered in the
 * interface from being usable by name but never chosen by default, which reads
 * to the user as "saving the key did nothing".
 */
export function defaultModelSpec(
	env: NodeJS.ProcessEnv = process.env,
	alsoConfigured: ReadonlySet<string> = new Set(),
): string | undefined {
	const preset = PROVIDER_PRESETS.find((item) => alsoConfigured.has(item.id) || present(env[item.envVar]));
	return preset ? `${preset.id}/${preset.defaultModel}` : undefined;
}
