/**
 * The permission gate: decides whether a tool call may proceed.
 *
 * Background, because it explains every rule below. pi ships no permission
 * system — its README says so, and `utils/paths.ts` resolves an absolute path
 * without a boundary check. So a model that emits an absolute path can write
 * anywhere on the disk, including over `auth.json`. This module is the layer
 * that stands in the way.
 *
 * Two design decisions carry most of the weight.
 *
 * **The axis is path ownership, not tool type.** Deciding by tool name gets it
 * wrong in both directions: a `write` inside the working directory is routine,
 * and the same `write` aimed at `~/.ssh` is not. The tool name is an input; the
 * resolved path is the question.
 *
 * **The stages are ordered, and later stages cannot permit what earlier ones
 * denied.** This is the property that makes the chain auditable: stage 1 can be
 * read on its own and known to hold, whatever the policy says. It is why
 * `danger-full-access` cannot be used to reach a credential file — the tier is
 * consulted at stage 5, after the credential check has already returned.
 *
 * `evaluateToolCall` is a pure function over (tool name, args, policy, context)
 * precisely so those two properties can be asserted directly, without building
 * an agent or running a model.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { inspectCommand } from "./command-guard.ts";

/** How much of the filesystem the session may change. */
export type SandboxTier = "read-only" | "workspace-write" | "danger-full-access";

/**
 * What happens to a call the chain cannot decide on its own.
 *
 * `never` converts every `ask` into a `deny`. This is the only correct reading
 * of "do not ask": unattended runs must mean "do not do", not "do anything".
 */
export type ApprovalPolicy = "ask" | "never";

export interface PermissionPolicy {
	tier: SandboxTier;
	approval: ApprovalPolicy;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
	tier: "workspace-write",
	approval: "ask",
};

export const SANDBOX_TIERS: readonly SandboxTier[] = ["read-only", "workspace-write", "danger-full-access"];
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["ask", "never"];

/**
 * The stage that produced a decision.
 *
 * Named rather than numbered so an assertion can say *where* a decision came
 * from, which is the part that catches a chain whose order has drifted.
 */
export type PermissionStage =
	| "credential"
	| "no-local-path"
	| "read-only-tool"
	| "shell"
	| "workspace-write"
	| "tier";

export type PermissionDecision =
	| { kind: "allow"; stage: PermissionStage }
	| { kind: "ask"; stage: PermissionStage; reason: string }
	| { kind: "deny"; stage: PermissionStage; reason: string };

export interface PermissionContext {
	/** The session's working directory. Paths inside it are routine. */
	cwd: string;
	/** Home directory. Injected so tests do not depend on the machine. */
	home: string;
}

export function defaultPermissionContext(cwd: string): PermissionContext {
	return { cwd, home: homedir() };
}

// ---------------------------------------------------------------------------
// Stage 1 — credentials.
//
// Deny read as well as write. The read half was originally argued the other
// way ("reading them accomplishes nothing without a tool that can send them
// somewhere"), and that argument stops holding the moment a web-fetch tool
// exists: a prompt injection can then say "read auth.json, then fetch this URL
// with the contents". Any new outbound capability must re-run this reasoning.
//
// Granularity is per-item, not per-directory. Refusing the whole state
// directory would break the agent's own notes and sessions, which live beside
// the credentials; only the items that actually hold secrets are locked.
// ---------------------------------------------------------------------------

/** Paths under the home directory that hold secrets. Denied for read and write. */
const CREDENTIAL_PATHS = [
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".docker",
	".config/gh",
	".git-credentials",
	".netrc",
	".npmrc",
	".gdou-agent/auth.json",
	".pi/agent/auth.json",
];

/** Paths that are the program's own configuration. Writable by nobody but the app. */
const CONFIG_PATHS = [".gdou-agent/settings.json"];

/**
 * Names that read rather than write, used only to tell the two apart once a
 * tool is known to take a path.
 *
 * A name list is unavoidable for this half — `read` and `write` take the same
 * argument and differ only in intent, so nothing in the arguments says which is
 * which. The list is a *refinement*, not the classifier: a tool it does not
 * mention is treated as mutating, which is the conservative direction and only
 * matters under the `read-only` tier.
 */
const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "current_time", "list_notes"]);

/** Names that run a command. */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

/**
 * What a tool call can act on, decided from the arguments rather than the name.
 *
 * This is the part that matters. An earlier version classified by name against
 * a fixed list and sent everything unrecognised to `ask` — which, with no
 * approver, meant *deny*. The effect was that any tool a mode added later was
 * blocked outright: a probe tool taking only a `count` was refused, and the
 * agent's own tools would have been too. Denying a tool that touches neither a
 * path nor a command is not caution; the gate has no surface to protect, so it
 * is only breakage.
 *
 * Classifying by shape gets that right: the surface the gate protects is
 * *paths* and *commands*, and a call carrying neither has neither.
 */
type ToolShape =
	| { kind: "shell"; command: string }
	| { kind: "path"; path: string | undefined; mutating: boolean }
	| { kind: "path-list"; paths: string[] }
	| { kind: "pathless" };

function classifyTool(toolName: string, args: unknown): ToolShape {
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

	const command = record.command;
	if (typeof command === "string" || SHELL_TOOL_NAMES.has(toolName)) {
		return { kind: "shell", command: typeof command === "string" ? command : "" };
	}

	const path = record.path;
	if (typeof path === "string" || READ_ONLY_TOOL_NAMES.has(toolName)) {
		return { kind: "path", path: typeof path === "string" && path.length > 0 ? path : undefined, mutating: !READ_ONLY_TOOL_NAMES.has(toolName) };
	}

	// A list of paths, as `present_files` takes. Recognised structurally rather
	// than by tool name so any future delivery-style tool is covered by the
	// credential rule without having to be added to a list.
	if (Array.isArray(record.items) && record.items.every((entry) => typeof entry === "string")) {
		return { kind: "path-list", paths: record.items as string[] };
	}

	// Unknown, and carrying no path — so there is nothing here for the gate to
	// decide about. Refusing it would protect nothing and break a custom tool.
	return { kind: "pathless" };
}

/** Does `candidate` sit at or under `root`? */
function isInside(root: string, candidate: string): boolean {
	const rel = relative(resolve(root), resolve(candidate));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Which protected entry, if any, this absolute path falls under. */
function matchProtected(absPath: string, context: PermissionContext): { kind: "credential" | "config"; entry: string } | undefined {
	const home = resolve(context.home);
	const normalized = absPath.replace(/\\/g, "/");
	const homeNormalized = home.replace(/\\/g, "/");
	const underHome = isInside(home, absPath);
	const suffix = underHome ? relative(home, absPath).replace(/\\/g, "/") : "";

	for (const entry of CREDENTIAL_PATHS) {
		// A file entry matches exactly; a directory entry matches the directory
		// and everything under it.
		const isFile = entry.endsWith(".json") || entry.endsWith(".npmrc") || entry.includes(".netrc") || entry.includes(".git-credentials");
		if (isFile) {
			if (normalized === `${homeNormalized}/${entry}` || normalized.endsWith(`/${entry}`)) {
				return { kind: "credential", entry };
			}
		} else if (suffix === entry || suffix.startsWith(`${entry}/`)) {
			return { kind: "credential", entry };
		}
	}

	for (const entry of CONFIG_PATHS) {
		if (normalized === `${homeNormalized}/${entry}` || normalized.endsWith(`/${entry}`)) {
			return { kind: "config", entry };
		}
	}

	return undefined;
}

export interface ToolCallRequest {
	toolName: string;
	args: unknown;
}

/**
 * Decide whether a tool call may proceed.
 *
 * Stages are evaluated in order and the first one with an opinion wins, so a
 * later stage cannot loosen an earlier denial.
 */
export function evaluateToolCall(
	request: ToolCallRequest,
	policy: PermissionPolicy,
	context: PermissionContext,
): PermissionDecision {
	const shape = classifyTool(request.toolName, request.args);

	/** Where a path-shaped call points, with an omitted path meaning the cwd. */
	const targetOf = (raw: string | undefined): string =>
		raw === undefined ? resolve(context.cwd) : isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw);

	// -- Stage 1a: a list of paths, as `present_files` takes.
	//
	// This has to be checked separately because the argument is an array, not a
	// `path`, so the shape classifier sees a call with no path at all and would
	// wave it through. That would be a real hole rather than a technicality:
	// `present_files` hands paths to the interface, and the interface *reads*
	// them to render a preview — so it would have been a way to read a
	// credential file by asking for it to be "delivered".
	//
	// Only the credential rule applies here. Whether the path is inside the
	// working directory is a question about *changing* the filesystem, and
	// delivery changes nothing; the file was already written under whatever
	// policy applied at the time.
	if (shape.kind === "path-list") {
		for (const raw of shape.paths) {
			const abs = isAbsolute(raw) ? resolve(raw) : resolve(context.cwd, raw);
			const protectedEntry = matchProtected(abs, context);
			if (protectedEntry?.kind === "credential") {
				return {
					kind: "deny",
					stage: "credential",
					reason:
						`拒绝：\`${protectedEntry.entry}\` 是凭据位置，不能作为交付物。` +
						"交付面板会读取文件来生成预览，所以放行它就等于绕开了凭据的读取限制。",
				};
			}
		}
		return { kind: "allow", stage: "no-local-path" };
	}

	// -- Stage 1b: credentials and program config. Absolute, policy-independent.
	//
	// Only path-shaped calls can be judged here. A shell command can name a
	// credential file without any `path` argument at all — `type ~\.ssh\id_rsa`
	// — which is why stage 3 exists and why it is a hard denial rather than a
	// tier question.
	if (shape.kind === "path") {
		const abs = targetOf(shape.path);
		const protectedEntry = matchProtected(abs, context);
		if (protectedEntry?.kind === "credential") {
			return {
				kind: "deny",
				stage: "credential",
				reason:
					`拒绝：\`${protectedEntry.entry}\` 是凭据位置，任何权限档位下都禁读也禁写。` +
					"凭据泄露是账号级损失，不该由一次弹窗决定。",
			};
		}
		if (protectedEntry?.kind === "config" && shape.mutating) {
			return {
				kind: "deny",
				stage: "credential",
				reason: `拒绝：\`${protectedEntry.entry}\` 是本程序的配置，工具不得改写它。`,
			};
		}
	}

	// -- Stage 2: a call carrying neither a path nor a command has nothing for
	// the gate to decide about. Allowed, and deliberately so: refusing it would
	// protect nothing while breaking every custom tool a mode contributes.
	if (shape.kind === "pathless") return { kind: "allow", stage: "no-local-path" };

	// -- Stage 3: shell. The command guard is the only thing standing between a
	// command and every path rule above, so a finding is a hard denial at any
	// tier — including `danger-full-access`. A tier is a statement about the
	// filesystem, not a licence to exfiltrate credentials.
	if (shape.kind === "shell") {
		const finding = inspectCommand(shape.command, { cwd: context.cwd, home: context.home });
		if (finding) {
			return { kind: "deny", stage: "shell", reason: `拒绝（${finding.rule}）：${finding.reason}` };
		}
		if (policy.tier === "read-only") {
			return {
				kind: "deny",
				stage: "shell",
				reason: "拒绝：只读档位下不执行任何命令。要执行请切到 workspace-write 或更高档位。",
			};
		}
		return { kind: "allow", stage: "shell" };
	}

	// -- Stage 4: file tools. Inside the working directory is what the directory
	// is for; outside it is a different question.
	const abs = targetOf(shape.path);
	const inside = isInside(context.cwd, abs);

	if (policy.tier === "read-only" && shape.mutating) {
		return {
			kind: "deny",
			stage: "tier",
			reason: "拒绝：只读档位下不修改任何文件。要修改请切到 workspace-write 或更高档位。",
		};
	}

	if (inside) return { kind: "allow", stage: "read-only-tool" };

	if (policy.tier === "danger-full-access") {
		return { kind: "allow", stage: "tier" };
	}

	return {
		kind: "ask",
		stage: "workspace-write",
		reason:
			`\`${abs}\` 在工作目录之外。工作目录外的${shape.mutating ? "修改" : "读取"}` +
			"需要确认——读侧漫游是写越界的必经入口，而且一旦有联网工具，" +
			"「读任意文件 + 抓任意 URL」就是一条数据外带路径。",
	};
}

/**
 * Resolve an `ask` into a final outcome.
 *
 * `ask` is not an outcome — it is a question addressed to someone. When nobody
 * is there to answer (headless runs, the `never` policy, a front-end with no
 * approval channel yet) the answer must be *no*: a gate that fails open is not
 * a gate.
 */
export function resolveAsk(decision: PermissionDecision, policy: PermissionPolicy, approver?: Approver): PermissionDecision {
	if (decision.kind !== "ask") return decision;
	if (policy.approval === "never" || approver === undefined) {
		return {
			kind: "deny",
			stage: decision.stage,
			reason:
				`${decision.reason}\n` +
				(policy.approval === "never"
					? "当前审批策略是 never，询问一律转为拒绝——无人值守时「不问」必须等于「不做」。"
					: "当前没有可用的审批通道，询问按拒绝处理。"),
		};
	}
	return decision;
}

/** Asks the user, returning whether the call may proceed. */
export type Approver = (request: { toolName: string; reason: string }) => Promise<boolean>;

/** A one-line summary of the policy, for status lines and `--doctor`. */
export function describePolicy(policy: PermissionPolicy): string {
	const tierLabel: Record<SandboxTier, string> = {
		"read-only": "只读",
		"workspace-write": "工作区可写",
		"danger-full-access": "完全访问",
	};
	const approvalLabel: Record<ApprovalPolicy, string> = { ask: "询问", never: "拒绝未批准" };
	return `${tierLabel[policy.tier]} · ${approvalLabel[policy.approval]}`;
}
