/**
 * The `delegate` tool: spawn a sub-agent for a self-contained sub-task.
 *
 * This is the alignment item C10 (子代理), and the first real *consumer* of the
 * B7 mechanism — a sub-agent can be pointed at a cheaper model, which is the
 * "scene model variant" idea finally doing work instead of being a knob the user
 * turns.
 *
 * How it works: `execute` builds a **separate** `AgentSession` via `createAgent`,
 * runs one prompt to completion, and returns the final assistant text. The
 * sub-agent gets its own context (it does not inherit the parent's transcript),
 * which is the whole point — a long, self-contained digression should not spend
 * the parent's context budget or clutter its messages.
 *
 * Two decisions worth stating:
 *
 * - **The sub-agent inherits the parent's mode** (not hard-coded to `coding`).
 *   A sub-agent's tools are the parent's tools, so the permission surface does
 *   not grow behind the user's back: a delegate from a read-only mode cannot
 *   reach the filesystem through the sub-agent. This matters because a sub-agent
 *   that quietly gained file access would be a permission escalation, not a
 *   convenience.
 *
 * - **The sub-agent does not get `delegate` itself.** Without that, a sub-agent
 *   could spawn another, and a task of "delegate everything" becomes an infinite
 *   tree. The parent passes `includeDelegate: false`, so recursion stops after
 *   exactly one level. (Nested delegation is genuinely useful, but it is a
 *   separate decision to make deliberately, not an accident of the wiring.)
 *
 * - **The sub-agent's failures are its result, not the parent's crash.** If the
 *   sub-agent throws, the tool returns that as text — the parent decides what to
 *   do with a failed sub-task, exactly as it does with any other tool error. A
 *   `delegate` that re-threw would take the parent's whole run down over one bad
 *   sub-task.
 *
 * The model is resolved the same way the parent's is — explicit spec, then the
 * settings default — so a `delegate` with no model argument runs on the same
 * model as the parent. The `model` argument is where B7 pays off: a cheap lite
 * model for a sub-task that does not need the big one.
 */

import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createAgent } from "../kernel/agent.ts";

const delegateSchema = Type.Object({
	task: Type.String({ description: "The self-contained task to hand off, with enough context to run alone" }),
	model: Type.Optional(
		Type.String({ description: "Optional 'provider/modelId' to run the sub-agent on (e.g. a cheaper lite model)" }),
	),
});

/** Extract the readable text from a pi assistant message's content array. */
function assistantText(message: { content: { type: string; text?: string }[] }): string {
	return message.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

export function delegateTool(cwd: string, mode: string, streamFn?: StreamFn): AgentTool<typeof delegateSchema, { task: string }> {
	return {
		name: "delegate",
		label: "Delegate",
		description:
			"Hand a self-contained sub-task to a separate agent with its own context, and get its final answer back. " +
			"The sub-agent has the same tools as this conversation — if you can read files and run commands, so can it. " +
			"Use it to offload work that would clutter this conversation or burn the context budget.",
		parameters: delegateSchema,

		async execute(_toolCallId, params) {
			const sub = await createAgent({
				recipe: { mode },
				model: params.model,
				cwd,
				// The sub-agent runs one prompt and reports text back; it must not
				// be able to spawn sub-agents of its own, or "delegate everything"
				// becomes an unbounded tree.
				includeDelegate: false,
				// Inherit the parent's transport, so a scripted run stays scripted
				// instead of falling back to a real provider mid-preview.
				...(streamFn ? { streamFn } : {}),
			});

			try {
				await sub.agent.prompt(params.task);
				const messages = sub.agent.state.messages;
				const last = [...messages].reverse().find((message) => message.role === "assistant");
				const text = last ? assistantText(last) : "";
				return {
					content: [{ type: "text" as const, text: text || "（子代理没有返回文本）" }],
					details: {
						task: params.task,
						mode,
						model: `${sub.model.provider}/${sub.model.id}`,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `子代理执行失败：${message}` }],
					details: { task: params.task, error: message },
				};
			} finally {
				sub.dispose();
			}
		},
	};
}
