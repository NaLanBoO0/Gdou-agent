/**
 * MCP client: connect to a stdio server and expose its tools.
 *
 * Thin wrapper over `@modelcontextprotocol/sdk` that gives the rest of the
 * kernel one object to talk to. It owns the child process lifecycle — the
 * server is spawned, connected, and torn down here, and nowhere else — so a
 * call site cannot accidentally leave a process running.
 *
 * Only stdio for now. That is the transport a local tool server almost always
 * uses (`npx -y @some/mcp-server`), and it is the one whose security story we
 * already understand: the server is a child process the permission gate can
 * account for by name.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { expandEnv, type McpServerConfig } from "./config.ts";

/** One tool exposed by a connected server, as the model will see it. */
export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpClient {
	/** Server name, for diagnostics and permission labels. */
	readonly name: string;
	/** Connect and enumerate tools. Throws on failure. */
	connect(): Promise<void>;
	/** Tools advertised by the server after `connect`. */
	tools(): McpTool[];
	/** Invoke a tool. Throws on transport or server error. */
	call(name: string, args: Record<string, unknown>): Promise<string>;
	/** Terminate the child process. Idempotent. */
	close(): Promise<void>;
}

/** Connect to a stdio MCP server and return a client for it. */
export function createMcpClient(name: string, config: McpServerConfig): McpClient {
	let transport: StdioClientTransport | undefined;
	let connected = false;
	let listed: McpTool[] = [];

	const client = new Client({ name: "gdou-agent", version: "0.1.0" });

	const connect = async () => {
		if (connected) return;
		// `process.env` has `string | undefined` values; the transport wants plain
		// strings, so undefined entries are dropped (they are already undefined to
		// the child's environment by definition).
		const base: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
		const env = { ...base, ...(config.env ? expandEnvRecord(config.env) : {}) };
		transport = new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env,
			cwd: config.cwd,
		});
		await client.connect(transport);
		const result = await client.listTools();
		listed = result.tools.map((t: Tool) => ({
			name: t.name,
			description: t.description ?? "",
			inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
		}));
		connected = true;
	};

	const call = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
		if (!connected) await connect();
		const result = await client.callTool({ name: toolName, arguments: args });
		const content = result.content as Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string } }> | undefined;
		// A tool result is a list of content parts; flatten to text for the model.
		const parts: string[] = [];
		for (const item of content ?? []) {
			if (item.type === "text") parts.push(item.text ?? "");
			else if (item.type === "image") parts.push(`[image: ${item.mimeType}]`);
			else if (item.type === "resource") parts.push(`[resource: ${item.resource?.uri ?? "?"}]`);
			else parts.push(JSON.stringify(item));
		}
		if (result.isError) throw new Error(parts.join("\n") || "MCP tool returned an error.");
		return parts.join("\n");
	};

	const close = async () => {
		if (transport) {
			await client.close().catch(() => {});
			transport = undefined;
		}
		connected = false;
	};

	return {
		name,
		connect,
		tools: () => listed,
		call,
		close,
	};
}

/** Expand `${VAR}` in every env value, keyed for `StdioClientTransport`. */
function expandEnvRecord(env: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) out[key] = expandEnv(value);
	return out;
}
