#!/usr/bin/env node
/**
 * A minimal MCP server for smoke tests.
 *
 * Speaks just enough of the MCP stdio protocol (JSON-RPC over stdio) for the
 * client under test to list tools and call one. Two tools: `echo` (returns its
 * argument) and `add` (sums two numbers). No framework dependency, so the test
 * does not need the SDK's server half installed to prove the client half.
 */

const TOOLS = [
	{
		name: "echo",
		description: "Return the given text unchanged.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
	},
	{
		name: "add",
		description: "Add two integers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "integer" }, b: { type: "integer" } },
			required: ["a", "b"],
		},
	},
];

let buffer = "";

process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		handle(message);
	}
});

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function handle(message) {
	const { id, method, params } = message;
	switch (method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "smoke-mcp", version: "1.0.0" },
				},
			});
			return;
		case "notifications/initialized":
			return; // no response for a notification
		case "tools/list":
			send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			return;
		case "tools/call": {
			const { name, arguments: args } = params;
			let text;
			if (name === "echo") text = String(args?.text ?? "");
			else if (name === "add") text = String((Number(args?.a) ?? 0) + (Number(args?.b) ?? 0));
			else {
				send({ jsonrpc: "2.0", id, result: { content: [], isError: true } });
				return;
			}
			send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
			return;
		}
		default:
			send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
	}
}
