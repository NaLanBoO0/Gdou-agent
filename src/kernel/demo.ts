/**
 * A scripted run.
 *
 * The GUI needs a model to do anything, and the usual way to get one is an API
 * key. That leaves two gaps. Someone who wants to look at the interface before
 * configuring anything cannot. And the parts of the UI that only exist during a
 * run — text streaming in, a tool call appearing and filling with output — are
 * exactly the parts that break silently, because nobody exercises them without
 * spending tokens.
 *
 * This replays a fixed script instead of calling a provider. No credentials are
 * involved: `createAgent` accepts an explicit model spec, and an explicit spec
 * is resolved for its metadata only, so the missing-credentials path is never
 * reached.
 *
 * Enabled with `GDOU_SCRIPTED_RUN=1`.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";

/** A transport, plus the model spec to resolve against it. */
export interface ScriptedRun {
	streamFn: StreamFn;
	/** Any built-in spec will do; the scripted transport ignores the model. */
	model: string;
}

/**
 * Tools the script is willing to call, in preference order.
 *
 * Restricted to tools that take no required arguments, so the script can never
 * ask for something nonsensical — a `read` with no path, say. Whichever of
 * these the active profile actually exposes is the one used.
 */
const CALLABLE_TOOLS = ["current_time", "list_notes", "ls"] as const;

/**
 * A file the scripted run can hand over, if one of these exists in the working
 * directory.
 *
 * Delivery is the one feature a preview otherwise cannot show: it needs a real
 * file to point at, and the scripted run has no model to invent one. Presenting
 * something that actually exists keeps the preview honest — the card opens a
 * file the user can look at.
 */
const PRESENTABLE_FILES = ["README.md", "package.json"];

/** A file worth showing, or undefined when the directory has none. */
function findPresentable(cwd: string): string | undefined {
	for (const name of PRESENTABLE_FILES) {
		const candidate = join(cwd, name);
		if (existsSync(candidate)) return candidate;
	}
	// Fall back to any file: the preview is often opened in a fresh directory,
	// and "nothing to show" is a worse demo than "here is a file".
	try {
		const entry = readdirSync(cwd, { withFileTypes: true }).find((item) => item.isFile());
		return entry ? join(cwd, entry.name) : undefined;
	} catch {
		return undefined;
	}
}

/** A model that exists in the built-in catalog, used for its metadata only. */
const METADATA_MODEL = "deepseek/deepseek-flash";

/**
 * Build a scripted run for a profile that exposes `toolNames`.
 *
 * Two assistant turns: one that says what it is doing and calls a tool, then
 * one that closes the run. If the profile exposes none of `CALLABLE_TOOLS` the
 * script skips the tool call rather than calling something that does not exist.
 */
export function scriptedRun(toolNames: readonly string[], cwd?: string): ScriptedRun {
	// Delivery is preferred over the generic probe when the profile supports it
	// and a real file is available: it shows the artifact card, which is the
	// part of the interface a preview most needs to demonstrate.
	const presentable =
		cwd !== undefined && toolNames.includes("present_files") ? findPresentable(cwd) : undefined;

	// Two calls, not one, so the preview exercises tool grouping — a single call
	// never forms a group, and a fold the preview cannot show is a fold nobody
	// has looked at.
	const calls = [];
	if (presentable) calls.push(fauxToolCall("present_files", { items: [presentable] }));
	for (const name of CALLABLE_TOOLS) {
		if (calls.length >= 2) break;
		if (toolNames.includes(name)) calls.push(fauxToolCall(name, {}));
	}

	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			calls.length > 0
				? [fauxText("这是脚本化运行的示例，用来在没有 API key 时预览界面。我先调用一个工具。"), ...calls]
				: [fauxText("这是脚本化运行的示例，用来在没有 API key 时预览界面。")],
			{ stopReason: calls.length > 0 ? "toolUse" : "stop" },
		),
		fauxAssistantMessage(
			[
				fauxText(
					calls.length > 0
						? "工具执行完毕。真实对话需要在环境变量里配置一个 provider 的 key。"
						: "真实对话需要在环境变量里配置一个 provider 的 key。",
				),
			],
			{ stopReason: "stop" },
		),
	]);

	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();

	return {
		streamFn: (_model, context, options) => models.streamSimple(model, context, options),
		model: METADATA_MODEL,
	};
}

/** Whether the scripted transport was requested. */
export function scriptedRunEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.GDOU_SCRIPTED_RUN;
	return value === "1" || value?.toLowerCase() === "true";
}
