/**
 * MCP orchestration.
 *
 * The entry point the kernel calls once per session: load the config, connect
 * every configured server, and hand back the tools to mount plus a way to tear
 * the servers down when the session ends.
 *
 * Failures are per-server, not per-session: one broken server is reported and
 * skipped, because taking down the whole agent for a single misconfigured MCP
 * entry would be a worse failure than the missing tools it was meant to avoid.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createMcpClient, type McpClient } from "./client.ts";
import { loadMcpConfig, type McpServerConfig } from "./config.ts";
import { mcpToolAsAgentTool } from "./tool.ts";
import { isMcpServerApproved } from "./approval.ts";

export interface McpSession {
	/** All tools from all connected servers, ready to mount on the agent. */
	tools: AgentTool[];
	/** Servers that failed to connect, as `name: reason`. */
	errors: Record<string, string>;
	/** Terminate every server process. Call when the session ends. */
	close(): Promise<void>;
}

export async function connectMcp(cwd: string): Promise<McpSession> {
	const config = loadMcpConfig(cwd);
	const clients: McpClient[] = [];
	const tools: AgentTool[] = [];
	const errors: Record<string, string> = {};

	for (const [name, entry] of Object.entries(config)) {
		if (!entry || typeof entry !== "object" || typeof (entry as McpServerConfig).command !== "string") {
			errors[name] = "配置缺少 command";
			continue;
		}
		// I4 approval: an unapproved server is never spawned. It is reported, not
		// skipped silently — its tools being absent would otherwise look like the
		// config was never read.
		if (!isMcpServerApproved(name)) {
			errors[name] = "待用户批准（MCP 首次连接需要确认）";
			continue;
		}
		const client = createMcpClient(name, entry as McpServerConfig);
		try {
			await client.connect();
			clients.push(client);
			for (const tool of client.tools()) tools.push(mcpToolAsAgentTool(client, tool));
		} catch (error) {
			errors[name] = (error as Error).message;
		}
	}

	return {
		tools,
		errors,
		close: async () => {
			await Promise.all(clients.map((c) => c.close()));
		},
	};
}
