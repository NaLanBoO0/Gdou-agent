/**
 * Model runtime.
 *
 * Owns the `Models` collection and resolves a concrete model from a spec string.
 * pi-ai's built-in providers already know how to read API keys from the
 * environment, so registration is the whole job here.
 */

import type { Model, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { PROVIDER_PRESETS, defaultModelSpec } from "../config/providers.ts";

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

	static create(): ModelRuntime {
		return new ModelRuntime(builtinModels());
	}

	/** Every model of every registered provider. */
	all(): readonly Model<string>[] {
		return this.models.getModels();
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
	 * provider whose API key is present in the environment.
	 */
	resolveDefault(explicitSpec?: string): Model<string> | undefined {
		if (explicitSpec) {
			const model = this.resolve(explicitSpec);
			if (!model) throw new Error(`Unknown model: ${explicitSpec}`);
			return model;
		}
		const fromEnv = defaultModelSpec();
		return fromEnv ? this.resolve(fromEnv) : undefined;
	}

	/** Models whose provider has usable credentials. */
	async available(): Promise<readonly Model<string>[]> {
		return this.models.getAvailable();
	}

	/** Credential status per preset, for diagnostics. */
	credentialReport(env: NodeJS.ProcessEnv = process.env): string {
		return PROVIDER_PRESETS.map((preset) => {
			const value = env[preset.envVar];
			const present = typeof value === "string" && value.trim().length > 0;
			return `  ${present ? "[x]" : "[ ]"} ${preset.label.padEnd(16)} ${preset.envVar}`;
		}).join("\n");
	}
}
