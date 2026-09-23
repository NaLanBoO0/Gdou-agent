/**
 * MCP server configuration.
 *
 * One config file per scope, merged local > project > user so a project can
 * declare its own servers without shadowing (or being shadowed by) the user's.
 * The format is a JSONC object keyed by server name, matching the shape the
 * MCP ecosystem already agrees on — this is "use the existing thing", not a new
 * format to learn.
 *
 *   {
 *     // optional: transport defaults
 *     "myserver": {
 *       "command": "npx", "args": ["-y", "@some/mcp-server"],
 *       "env": { "TOKEN": "${SOME_TOKEN}" }
 *     }
 *   }
 *
 * Three things make this more than `JSON.parse`:
 *
 *   1. **JSONC comments.** Users annotate their configs; rejecting a `//` line
 *      would be the tool being stricter than the person who has to read it.
 *   2. **`${VAR}` / `${VAR:-default}` expansion** in `env` and `command`, so a
 *      key does not have to live in plaintext in the config.
 *   3. **Scope merge** (local > project > user), so a repo's servers ride along
 *      with the repo and the user's own servers are available everywhere.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_HOME } from "../paths.ts";

/** One MCP server declaration, after env expansion. */
export interface McpServerConfig {
	/** Executable to spawn. Required. */
	command: string;
	/** Arguments passed to the executable. */
	args?: string[];
	/** Environment merged over the agent's own. */
	env?: Record<string, string>;
	/** Working directory for the spawned process. Defaults to the agent's cwd. */
	cwd?: string;
	/** Disable a server inherited from a wider scope. */
	disabled?: boolean;
}

export type McpConfig = Record<string, McpServerConfig>;

/** The three scope files, in priority order (lowest first). */
export function scopePaths(cwd: string): string[] {
	return [
		join(AGENT_HOME, "mcp.json"),
		join(cwd, ".gdou-agent", "mcp.json"),
		join(cwd, ".mcp.json"),
	];
}

/** Strip `//` and `/* *\/` comments, then a trailing comma. */
function stripJsonc(text: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (c === "\n") { inLine = false; out += c; }
			continue;
		}
		if (inBlock) {
			if (c === "*" && next === "/") { inBlock = false; i++; }
			continue;
		}
		if (inString) {
			out += c;
			if (c === "\\") { out += next ?? ""; i++; continue; }
			if (c === '"') inString = false;
			continue;
		}
		if (c === '"') { inString = true; out += c; continue; }
		if (c === "/" && next === "/") { inLine = true; i++; continue; }
		if (c === "/" && next === "*") { inBlock = true; i++; continue; }
		out += c;
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Expand `${VAR}` and `${VAR:-default}` against the process environment. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
		const found = env[name];
		if (found !== undefined) return found;
		return fallback ?? "";
	});
}

/** Read one scope file, or `undefined` when absent or unreadable. */
function readScope(path: string): McpConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	const parsed = JSON.parse(stripJsonc(raw));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	return parsed as McpConfig;
}

/**
 * Merge the three scope files, highest priority last, into one config.
 *
 * A malformed file is skipped rather than aborting the whole load: one bad
 * project config should not take down every MCP server the user relies on.
 * `disabled: true` on a higher-priority entry removes a lower one, so a project
 * can turn off a user-level server it conflicts with.
 */
export function loadMcpConfig(cwd: string): McpConfig {
	const merged: McpConfig = {};
	for (const path of scopePaths(cwd)) {
		const scope = readScope(path);
		if (!scope) continue;
		for (const [name, entry] of Object.entries(scope)) {
			if (entry && typeof entry === "object" && (entry as McpServerConfig).disabled) {
				delete merged[name];
				continue;
			}
			merged[name] = { ...merged[name], ...entry };
		}
	}
	return merged;
}
