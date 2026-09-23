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
