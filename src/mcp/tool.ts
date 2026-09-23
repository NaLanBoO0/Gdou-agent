/**
 * MCP tools as agent tools.
 *
 * Each tool a connected server advertises becomes one `AgentTool`, so the model
 * calls it exactly like a built-in tool and the permission gate sees it like any
 * other — which is the whole point of the gate: an MCP tool is a third-party
 * action, and it must not get a free pass because it arrived over stdio.
 *
 * The name is prefixed (`mcp__<server>__<tool>`) so two servers exposing the
 * same tool name do not collide, and so the transcript and the permission label
 * both name the server that owns the action.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpClient, McpTool } from "./client.ts";
import { jsonSchemaToTypeBox } from "./schema.ts";

/** Build one `AgentTool` for a tool advertised by a connected MCP server. */
export function mcpToolAsAgentTool(client: McpClient, tool: McpTool): AgentTool {
	const prefixed = `mcp__${client.name}__${tool.name}`;
	return {
		name: prefixed,
		label: `${client.name} · ${tool.name}`,
		description: tool.description || `Tool ${tool.name} from the ${client.name} MCP server.`,
		parameters: jsonSchemaToTypeBox(tool.inputSchema),
		// `replay: "never"`: the server is a stateful third-party process, and
		// re-running a call whose outcome we lost is not guaranteed to be safe.
		replay: "never",

		async execute(_toolCallId, params) {
			const text = await client.call(tool.name, params as Record<string, unknown>);
			return {
				content: [{ type: "text" as const, text }],
				details: { server: client.name, tool: tool.name },
			};
		},
	};
}
