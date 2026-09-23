/**
 * Model runtime.
 *
 * Owns the `Models` collection and resolves a concrete model from a spec string.
 *
 * pi-ai's built-in providers already know how to read API keys, so the whole job
 * here is registration — but *which* credential store they read from matters,
 * and getting it wrong is invisible. `createModels()` defaults to an in-memory
 * store, so a collection built without one accepts a key, resolves it, and
 * forgets it at the end of the process: keys entered in the interface would
 * appear to save and then not be there next launch. The store is therefore
 * supplied explicitly, and `credentials.ts` owns what that means.
 */

import type { CredentialStore, Model, MutableModels } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore, normalizeContext } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PROVIDER_PRESETS, defaultModelSpec } from "../config/providers.ts";
import { credentialStore } from "./credentials.ts";

export interface ParsedSpec {
	/** Present only when the spec was written as "provider/model". */
	provider?: string;
	id: string;
}

/**
 * Parse "provider/modelId". A bare "modelId" is also accepted and resolved by
 * searching every registered provider, which is convenient for presets.
 */
export function parseModelSpec(spec: string): ParsedSpec {
	const slash = spec.indexOf("/");
	if (slash === -1) return { id: spec };
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export class ModelRuntime {
	readonly models: MutableModels;

	private constructor(models: MutableModels) {
		this.models = models;
	}

	/**
	 * `credentials` is a seam for tests, which need a store pointed at a
	 * temporary file. Everything else takes the process-wide one, so there is a
	 * single answer to "what is configured".
	 */
	static create(credentials?: CredentialStore): ModelRuntime {
		return new ModelRuntime(builtinModels({ credentials: credentials ?? credentialStore() }));
	}

	/** Every model of every registered provider. */
	all(): readonly Model<string>[] {
		return this.models.getModels();
	}

	/** Every model of one provider, in catalogue order. Empty for an unknown id. */
	modelsFor(providerId: string): readonly Model<string>[] {
		return this.models.getModels(providerId);
	}

	/** Resolve a model, or undefined when the spec matches nothing. */
	resolve(spec: string): Model<string> | undefined {
		const parsed = parseModelSpec(spec);
		if (parsed.provider !== undefined) {
			return this.models.getModel(parsed.provider, parsed.id);
		}
		for (const model of this.models.getModels()) {
			if (model.id === parsed.id) return model;
		}
		return undefined;
	}

	/**
	 * Resolve the model to use, in priority order: explicit spec, then the first
	 * preset that is configured — by an environment variable or by a key stored
	 * through the interface.
	 */
	resolveDefault(explicitSpec?: string): Model<string> | undefined {
		if (explicitSpec) {
			const model = this.resolve(explicitSpec);
			if (!model) throw new Error(`Unknown model: ${explicitSpec}`);
			return model;
		}
		const fromEnvironmentOrStore = defaultModelSpec(process.env, credentialStore().storedProviderIds());
		return fromEnvironmentOrStore ? this.resolve(fromEnvironmentOrStore) : undefined;
	}

	/** Models whose provider has usable credentials. */
	async available(): Promise<readonly Model<string>[]> {
		return this.models.getAvailable();
	}

	/**
	 * Credential status per preset, for diagnostics.
	 *
	 * A key stored through the interface is reported as such rather than lumped
	 * in with one that came from the environment. Both make a provider usable, so
	 * both get `[x]`, but "why is this working" and "where do I change it" have
	 * different answers and the difference costs one word here.
	 */
	credentialReport(env: NodeJS.ProcessEnv = process.env): string {
		const stored = credentialStore().storedProviderIds();
		return PROVIDER_PRESETS.map((preset) => {
			const value = env[preset.envVar];
			const fromEnv = typeof value === "string" && value.trim().length > 0;
			const mark = stored.has(preset.id) || fromEnv ? "[x]" : "[ ]";
			const source = stored.has(preset.id) ? "  (stored in the interface)" : "";
			return `  ${mark} ${preset.label.padEnd(16)} ${preset.envVar}${source}`;
		}).join("\n");
	}
}

/** Result of one `testModel` call, as the shell's connection test needs it. */
export interface ModelTestResult {
	success: boolean;
	elapsedMs: number;
	inputTokens: number;
	outputTokens: number;
	/** Present exactly when `success` is false. */
	error?: string;
}

export interface TestModelOptions {
	/**
	 * A key to test with, taken from the profile being edited. When absent, the
	 * provider's own configuration (stored or environment) is used — which makes
	 * "test" on an already-configured model honest about the live setup.
	 */
	apiKey?: string;
}

/**
 * One tiny request to a model, to answer "does this work?".
 *
 * The request is deliberately minimal: a one-word prompt, bounded output, and
 * the same transport a session would use, so a green test means the configured
 * key reaches the provider and a response comes back. A missing key is reported
 * as a failed test *before* any network attempt — the answer "there is nothing
 * configured" is faster and clearer than letting the provider SDK throw the
 * same fact through its own auth resolution.
 *
 * Any other failure surfaces as the provider's own message: a wrong key, a bad
 * model id, a network error are all real answers the user can act on, and
 * rewriting them into something of ours would lose the detail that names the
 * fix. Token totals come from the completed message's usage, when the provider
 * reports one.
 */
export async function testModel(spec: string, options: TestModelOptions = {}): Promise<ModelTestResult> {
	const started = Date.now();
	const runtime = ModelRuntime.create();
	const model = runtime.resolve(spec);
	if (!model) {
		return { success: false, elapsedMs: 0, inputTokens: 0, outputTokens: 0, error: `未知模型：${spec}` };
	}

	const fail = (error: string, elapsedMs = Date.now() - started): ModelTestResult => ({
		success: false,
		elapsedMs,
		inputTokens: 0,
		outputTokens: 0,
		error,
	});

	// A key passed in for the test wins over everything stored; otherwise the
	// real store is used, so "test" reflects what a session would actually do.
	let models = runtime.models;
	if (options.apiKey && options.apiKey.trim().length > 0) {
		const store = new InMemoryCredentialStore();
		await store.modify(model.provider, async () => ({ type: "api_key", key: options.apiKey!.trim() }));
		models = ModelRuntime.create(store).models;
	} else if (!(await configuredFor(model.provider))) {
		const preset = PROVIDER_PRESETS.find((item) => item.id === model.provider);
		const hint = preset ? `（${preset.envVar}）` : "";
		return fail(`未配置 API key ${hint}，无法测试。`);
	}

	try {
		const stream = models.streamSimple(
			model,
			normalizeContext({ messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }),
			{ maxTokens: 32 },
		);
		for await (const event of stream) {
			if (event.type === "done") {
				return {
					success: true,
					elapsedMs: Date.now() - started,
					inputTokens: event.message.usage.input,
					outputTokens: event.message.usage.output,
				};
			}
			if (event.type === "error") {
				return fail(event.error.errorMessage ?? "请求失败");
			}
		}
		return fail("请求没有返回结果");
	} catch (error) {
		// `streamSimple` throws synchronously when request auth is missing — a
		// stored-but-bad key, or no key at all for a provider pi did not resolve.
		return fail(error instanceof Error ? error.message : String(error));
	}
}

/**
 * Whether a provider can authenticate without a test-supplied key.
 *
 * Both sources pi consults count: a key stored through the interface and the
 * provider's environment variable. Presets know their env var by name; a
 * provider outside the presets is assumed to be configured until the request
 * proves otherwise — the synchronous auth failure is the safety net.
 */
async function configuredFor(providerId: string): Promise<boolean> {
	const stored = await credentialStore().read(providerId);
	if (stored) return true;
	const preset = PROVIDER_PRESETS.find((item) => item.id === providerId);
	if (!preset) return true;
	const env = process.env[preset.envVar];
	return typeof env === "string" && env.trim().length > 0;
}
