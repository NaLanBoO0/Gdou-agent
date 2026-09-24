/**
 * MCP server approval.
 *
 * Connecting an MCP server spawns a third-party process — that is the whole
 * transport — so "configured" and "allowed to run" must not be the same thing.
 * A config file lists servers; this file records which of them the user has
 * explicitly approved. `connectMcp` only connects approved servers and reports
 * the rest as "awaiting approval", so a misconfiguration cannot silently turn
 * into a remote execution without a human saying yes first.
 *
 * The approval file lives under `AGENT_HOME` like `auth.json`, so
 * `GDOU_AGENT_HOME` isolates it the same way. Keys are server names (which are
 * unique within the merged config), values are approval metadata.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_HOME } from "../paths.ts";

/** The approval file, one object of `name → { approvedAt }`. */
export function mcpApprovalPath(): string {
	return join(AGENT_HOME, "mcp-approvals.json");
}

type ApprovalFile = Record<string, { approvedAt: string }>;

/** Read the file, treating every kind of damage as "nothing approved". */
function loadFile(): ApprovalFile {
	try {
		const parsed = JSON.parse(readFileSync(mcpApprovalPath(), "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as ApprovalFile;
	} catch {
		return {};
	}
}

/** True when the named server has been approved by the user. */
export function isMcpServerApproved(name: string): boolean {
	return name in loadFile();
}

/** Every approved server name, sorted. */
export function approvedMcpServers(): string[] {
	return Object.keys(loadFile()).sort();
}

/**
 * Mark a server as approved.
 *
 * The write is atomic by construction (temp + rename) and synchronous, the same
 * discipline `credentials.ts` uses: the file is tiny, and a partial write must
 * never read as "approved" when the user never clicked.
 */
export function approveMcpServer(name: string): void {
	const file = loadFile();
	file[name] = { approvedAt: new Date().toISOString() };
	const path = mcpApprovalPath();
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(file, null, 2), "utf-8");
	renameSync(temp, path);
}
