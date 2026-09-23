/**
 * Dangerous-command inspection for the shell tool.
 *
 * Why this exists, stated precisely: pi's file tools resolve absolute paths
 * without any boundary check, so the permission gate in `permission.ts` protects
 * `read` / `write` / `edit`. A shell command walks straight past all of it —
 * `type ~\.ssh\id_rsa` is not a `read` call, so no amount of path checking on
 * the file tools would see it. This is the layer that covers that hole.
 *
 * What it is, and what it is not:
 *
 *   - It is a **blocklist over command text**. It raises the bar; it does not
 *     establish a boundary. A determined model can express the same intent in a
 *     form no pattern here matches, and obfuscation is unbounded.
 *   - It is therefore a **fail-safe, not a sandbox**. The real fix is an
 *     OS-level boundary (a restricted token, a job object), which is a much
 *     larger piece of work. Until then this catches the *common* forms, and the
 *     permission gate refuses shell outright under the `read-only` tier.
 *
 * The rules are chosen by one criterion: **does this defeat the path checks?**
 * Not "is this generally risky". Credential reads (they can be exfiltrated the
 * moment any outbound tool exists), broad recursive deletes (irreversible),
 * download-and-execute and encoded execution (arbitrary code with no readable
 * command to inspect). Generic "dangerous" commands like `format` are included
 * because they are cheap, not because they are the threat model.
 */

import { isAbsolute, relative, resolve } from "node:path";

/** A credential location, relative to the user's home directory. */
const CREDENTIAL_DIRS = [
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".docker",
	".config/gh",
	".git-credentials",
	".npmrc",
	".netrc",
	".pi",
	".gdou-agent",
];

/** File names that hold credentials wherever they appear. */
const CREDENTIAL_FILES = ["auth.json", "credentials", "id_rsa", "id_ed25519", "id_ecdsa"];

export interface CommandFinding {
	/** Stable identifier for the rule that matched, for assertions. */
	rule: string;
	/** Shown to the user and to the model. Must say what and why. */
	reason: string;
}

export interface CommandContext {
	/** The session's working directory, used to judge delete targets. */
	cwd: string;
	/** Home directory. Injected so tests do not depend on the machine. */
	home: string;
}

/**
 * Normalise for matching only — never for execution.
 *
 * Command text arrives in several shapes (PowerShell backticks, `$env:`, `~`,
 * quoted paths). Comparing against the raw string misses all of them, and the
 * misses are silent, which is the failure mode that matters here.
 */
function normalize(command: string): string {
	return command
		.toLowerCase()
		.replace(/\$env:/g, "")
		.replace(/["'`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Does the command text mention a credential location? */
function mentionsCredential(command: string, home: string): string | undefined {
	// `~` and `$home` both expand to the home directory, and an agent writing a
	// path will use one of them at least as often as the literal path.
	const homeForms = [home.toLowerCase().replace(/\\/g, "/"), "~", "$home", "%userprofile%"];
	const hasHome = homeForms.some((form) => form.length > 0 && command.includes(form));

	for (const dir of CREDENTIAL_DIRS) {
		const bare = dir.replace(/\\/g, "/");
		const name = bare.split("/").pop() ?? bare;
		// Match the path form (`/.ssh/`, `\.ssh\`) and the bare name only when a
		// home prefix is also present — otherwise `.npmrc` as a substring of an
		// unrelated word would trip it.
		if (command.includes(`/${name}/`) || command.includes(`\\${name}\\`)) return dir;
		if (hasHome && (command.includes(`/${name}`) || command.includes(`\\${name}`))) return dir;
	}
	for (const file of CREDENTIAL_FILES) {
		if (command.includes(file)) return file;
	}
	return undefined;
}

/**
 * Recursive deletes, but only where the target is worth refusing.
 *
 * `rm -rf node_modules` is routine and must stay allowed; `rm -rf /` is not.
 * The distinction is the target, so the target has to be read out of the
 * command rather than the command refused wholesale.
 */
function recursiveDeleteTarget(command: string, context: CommandContext): string | undefined {
	// Each pattern captures the target operand. Flags vary in order and spelling
	// across shells, so the patterns tolerate any order rather than enumerating
	// combinations.
	const patterns = [
		/\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-[a-z]*r)\s+(\S+)/g,
		/remove-item\b[^|;]*?-recurse[^|;]*?\s+(\S+)/g,
		/\b(?:rd|rmdir|del)\s+\/[sq]\b[^|;]*?\s+(\S+)/g,
	];

	const cwd = resolve(context.cwd);

	for (const re of patterns) {
		for (const match of command.matchAll(re)) {
			const raw = match[1] ?? "";

			// `/`, `~`, `$home`, `%userprofile%`, and bare drive roots are never
			// inside anything, so they are refused before anything else.
			//
			// This check has to come *before* the trailing-separator strip: that
			// strip turns `/` into an empty string, which then reads as "no
			// target given" and is skipped. `rm -rf /` — the single command this
			// rule most needs to catch — went straight through because of it.
			if (/^(?:\/+|~[/\\]*|\$home[/\\]*|%userprofile%[/\\]*|[a-z]:[\\/]?)$/.test(raw)) return raw;

			const target = raw.replace(/[/\\]+$/, "");
			if (target.length === 0) continue;

			if (!isAbsolute(target)) continue; // relative ⇒ inside the working directory

			// `path.relative` is the right test: it returns a path starting with
			// `..` exactly when the target is outside, and it handles the
			// drive-letter and case differences that string prefixing gets wrong.
			const rel = relative(cwd, resolve(target));
			if (rel.startsWith("..") || isAbsolute(rel)) return target;
		}
	}
	return undefined;
}

/** Commands that fetch a remote payload and hand it to an interpreter. */
const PIPE_TO_INTERPRETER = /\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|iex|invoke-expression|python[23]?|node|perl|ruby)\b/;

/** Encoded or otherwise unreadable execution. */
const ENCODED_EXECUTION = [
	/-encodedcommand\b/,
	/-enc\s+[a-z0-9+/=]{16,}/,
	/frombase64string/,
	/base64\s+(?:-d|--decode)\s*\|/,
];

/** Interactive shells handed to a remote peer. */
const REVERSE_SHELL = [/\bnc\b[^|;]*-e\b/, /\bncat\b[^|;]*-e\b/, /\/dev\/tcp\//, /\bmkfifo\b/];

/** Whole-disk destructive commands. Cheap to include. */
const DESTRUCTIVE = [/\bformat\s+[a-z]:/, /\bmkfs\b/, /\bdiskpart\b/, /\bcipher\s+\/w\b/, /\bvssadmin\b/];

/**
 * Inspect a shell command. Returns the first finding, or undefined when the
 * command is not matched by any rule.
 *
 * Order matters and is deliberate: the most specific and most damaging rules
 * run first so the reported reason is the most informative one. A command that
 * both reads a credential file and pipes something to a shell is reported as
 * the credential read, because that is the fact the user needs.
 */
export function inspectCommand(command: string, context: CommandContext): CommandFinding | undefined {
	if (command.trim().length === 0) return undefined;
	const normalized = normalize(command);

	const credential = mentionsCredential(normalized, context.home);
	if (credential !== undefined) {
		return {
			rule: "credential-access",
			reason:
				`命令引用了凭据位置 \`${credential}\`。凭据目录在任何权限档位下都禁读也禁写——` +
				"一旦有联网工具，读到就等同于泄露（提示注入可以诱导「读凭据 → 抓一个 URL 带上内容」）。",
		};
	}

	for (const pattern of ENCODED_EXECUTION) {
		if (pattern.test(normalized)) {
			return {
				rule: "encoded-execution",
				reason: "命令用编码方式执行内容（-EncodedCommand / FromBase64String 等）。编码后的载荷无法被审查，一律拒绝。",
			};
		}
	}

	if (PIPE_TO_INTERPRETER.test(normalized)) {
		return {
			rule: "download-and-execute",
			reason: "命令把远程内容直接管道给解释器执行。请先下载到工作目录、说明内容、再单独执行。",
		};
	}

	for (const pattern of REVERSE_SHELL) {
		if (pattern.test(normalized)) {
			return { rule: "reverse-shell", reason: "命令形态符合反弹 shell（netcat -e / /dev/tcp / mkfifo），拒绝。" };
		}
	}

	for (const pattern of DESTRUCTIVE) {
		if (pattern.test(normalized)) {
			return { rule: "destructive", reason: "命令会破坏磁盘或文件系统结构（format / mkfs / diskpart / cipher /w），拒绝。" };
		}
	}

	const target = recursiveDeleteTarget(normalized, context);
	if (target !== undefined) {
		return {
			rule: "recursive-delete-outside-workspace",
			reason:
				`递归删除的目标 \`${target}\` 在工作目录之外（或指向根/家目录）。` +
				"删除是不可逆的，工作目录外的递归删除一律拒绝；要删工作目录内的内容请用相对路径。",
		};
	}

	return undefined;
}
