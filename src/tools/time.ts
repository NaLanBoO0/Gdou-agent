/**
 * Current time tool.
 *
 * Exists to prove the tool pipeline works outside a coding context: no
 * filesystem, no shell, pure computation. Replace or extend as needed.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const currentTimeSchema = Type.Object({
	timeZone: Type.Optional(
		Type.String({ description: "IANA time zone, e.g. Asia/Shanghai. Defaults to the system zone." }),
	),
});

interface CurrentTimeDetails {
	iso: string;
	timeZone: string;
	error?: "invalid_time_zone";
}

export const currentTimeTool: AgentTool<typeof currentTimeSchema, CurrentTimeDetails> = {
	name: "current_time",
	label: "Current time",
	description: "Get the current date and time. Optionally in a specific IANA time zone.",
	parameters: currentTimeSchema,

	async execute(_toolCallId, params) {
		const now = new Date();
		const timeZone = params.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		try {
			const formatted = new Intl.DateTimeFormat("en-CA", {
				timeZone,
				dateStyle: "full",
				timeStyle: "long",
			}).format(now);
			return {
				content: [{ type: "text" as const, text: `${formatted} (${timeZone})` }],
				details: { iso: now.toISOString(), timeZone },
			};
		} catch {
			return {
				content: [{ type: "text" as const, text: `Unknown time zone: ${timeZone}` }],
				details: { iso: now.toISOString(), timeZone, error: "invalid_time_zone" as const },
			};
		}
	},
};
