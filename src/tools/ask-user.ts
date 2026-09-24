/**
 * The `ask_user` tool: a structured question to the person running the agent.
 *
 * Why this exists when the model can already ask in prose: a prose question
 * lands as a normal assistant message, and the user answers in the composer —
 * there is nothing wrong with that for a simple "which one?" But the shell's
 * question channel is richer: multiple-choice options, multi-select, and a
 * dedicated UI that pauses the run until an answer arrives. This tool is how a
 * model opts into that channel.
 *
 * The tool's `execute` returns only when the answer has arrived — the bridge
 * holds the promise open while the shell shows the question, and resolves it
 * with the user's answer. That is the entire mechanism: the run *waits*, the
 * answer comes back as the tool's text result, and the model continues from
 * where it left off.
 *
 * The actual "ask the user" step is injected, not built here: the kernel does
 * not know about sockets or the shell, so `askUserTool` takes a callback that
 * does the transport. A caller that does not want the capability simply does
 * not pass one, and the tool is absent.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** One question offered to the user. */
export interface AskUserQuestion {
	/** Short heading shown above the question, if any. */
	header?: string;
	/** The question itself. */
	question: string;
	/** Preset answers to choose from. */
	options: Array<{ label: string; description?: string }>;
	/** Whether more than one option may be selected. */
	multi_select: boolean;
}

const askUserSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			header: Type.Optional(Type.String()),
			question: Type.String(),
			options: Type.Array(
				Type.Object({
					label: Type.String(),
					description: Type.Optional(Type.String()),
				}),
			),
			multi_select: Type.Optional(Type.Boolean()),
		}),
	),
});

/**
 * Build the `ask_user` tool.
 *
 * `askUser` receives the questions and returns a promise of the user's answer
 * text. The bridge is responsible for turning that into the shell's question
 * UI and back — this function only orchestrates "wait for the answer, then
 * hand it to the model".
 */
export function askUserTool(
	askUser: (questions: AskUserQuestion[]) => Promise<string>,
): AgentTool<typeof askUserSchema, { questions: AskUserQuestion[] }> {
	return {
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the person running this session a question and wait for their answer. " +
			"Use it when a decision genuinely needs a human — which option to take, " +
			"which file to target — and the task cannot proceed sensibly without it. " +
			"The run pauses until they respond.",
		parameters: askUserSchema,

		async execute(_toolCallId, params) {
			const questions = (params.questions ?? []).map((question) => ({
				header: question.header,
				question: question.question,
				options: question.options ?? [],
				multi_select: question.multi_select ?? false,
			}));
			const text = await askUser(questions);
			return {
				content: [{ type: "text" as const, text }],
				details: { questions, user_answered: true },
			};
		},
	};
}
