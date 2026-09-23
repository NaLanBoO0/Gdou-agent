#!/usr/bin/env node
/**
 * Headless CLI.
 *
 * Exists to exercise the kernel end to end before any TUI exists, and to stay
 * useful afterwards for scripting. It renders normalized `AgentEvent`s, so it
 * also serves as the reference for how a richer front-end consumes them.
 */

import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadSettings, THINKING_LEVELS } from "./config/settings.ts";
import { PROVIDER_PRESETS } from "./config/providers.ts";
import { getExpert, loadExperts } from "./experts/registry.ts";
import { createAgent } from "./kernel/agent.ts";
import { CONTEXT_BUDGET_CHARS } from "./kernel/context.ts";
import type { AgentEvent } from "./kernel/events.ts";
import {
	APPROVAL_POLICIES,
	type ApprovalPolicy,
	DEFAULT_PERMISSION_POLICY,
	describePolicy,
	type PermissionPolicy,
	SANDBOX_TIERS,
	type SandboxTier,
} from "./kernel/permission.ts";
import { narrowTools, type RecipeRequest } from "./kernel/recipe.ts";
import { toolchainPaths } from "./kernel/toolchain.ts";
import { listProfiles, getProfile } from "./profiles/registry.ts";
import { AGENT_HOME, describePiSource, expertsDir, IS_BUNDLED, PROJECT_ROOT, projectExpertsDir } from "./paths.ts";
import { canRunTui, runTui } from "./tui/index.ts";
import { bold, cyan, dim, green, red, yellow } from "./ui/style.ts";

const USAGE = `${bold("gdou-agent")} - GDOU agent, a custom agent on the pi kernel

Usage:
  gdou-agent [options] [prompt]

With no prompt and an interactive terminal, the TUI starts instead.

Options:
  -p, --profile <id>     Mode to run (default: from settings, else general)
  -e, --expert <id>      Expert methodology to layer on top of the mode
  -m, --model <spec>     Model as provider/modelId
  -c, --cwd <path>       Working directory for mode tools
  -t, --thinking <level> off | minimal | low | medium | high | xhigh | max
      --sandbox <tier>   read-only | workspace-write | danger-full-access
      --approval <mode>  ask | never (never turns every question into a refusal)
      --yes              Answer every permission question with yes
      --tui              Force the interactive UI
      --json             Emit normalized events as JSONL instead of text
      --list-profiles    List available modes and exit
      --list-experts     List available experts and exit
      --list-providers   List supported providers and exit
      --list-tools [id]  List the tools a mode exposes, then exit
      --doctor           Show configuration and credential status, then exit
  -h, --help             Show this help

A session is a mode plus an optional expert. The mode decides what the agent can
do; the expert decides how it goes about it, and may only narrow the tool set.

Examples:
  gdou-agent                                        # interactive
  gdou-agent --list-profiles
  gdou-agent --list-experts
  gdou-agent -p coding "summarize this repo"
  gdou-agent -p coding -e security-audit "audit the auth flow"
  gdou-agent -p general "what is the time in Tokyo?"
  echo "explain closures" | gdou-agent -p general
`;

interface CliOptions {
	profile?: string;
	expert?: string;
	model?: string;
	cwd?: string;
	thinking?: ThinkingLevel;
	json: boolean;
	tui: boolean;
	prompt?: string;
	/** Filesystem tier for the permission gate. */
	sandbox?: SandboxTier;
	/** What happens to calls the chain cannot decide alone. */
	approval?: ApprovalPolicy;
	/**
	 * Answer every `ask` with yes.
	 *
	 * Deliberately spelled as an opt-in rather than as the default: `ask`
	 * resolving to a denial is the safe direction, and this flag is how a user
	 * says "I have read what it wants and I am here".
	 */
	yes: boolean;
}

/** Commands that exit without running a prompt. */
type CliCommand =
	| { kind: "help" }
	| { kind: "list-profiles" }
	| { kind: "list-experts" }
	| { kind: "list-providers" }
	| { kind: "list-tools"; profile?: string; expert?: string }
	| { kind: "doctor" };

function parseCli(argv: string[]): CliOptions | CliCommand {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			profile: { type: "string", short: "p" },
			expert: { type: "string", short: "e" },
			model: { type: "string", short: "m" },
			cwd: { type: "string", short: "c" },
			thinking: { type: "string", short: "t" },
			sandbox: { type: "string" },
			approval: { type: "string" },
			yes: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			tui: { type: "boolean", default: false },
			"list-profiles": { type: "boolean", default: false },
			"list-experts": { type: "boolean", default: false },
			"list-providers": { type: "boolean", default: false },
			"list-tools": { type: "boolean", default: false },
			doctor: { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});

	if (values.help) return { kind: "help" };
	if (values["list-profiles"]) return { kind: "list-profiles" };
	if (values["list-experts"]) return { kind: "list-experts" };
	if (values["list-providers"]) return { kind: "list-providers" };
	if (values["list-tools"]) {
		// Accept `--list-tools <profileId>` or `--list-tools -p <profileId>`.
		const fromPositional = positionals[0];
		const profile = values.profile ?? fromPositional;
		const command: CliCommand = { kind: "list-tools" };
		if (profile !== undefined) command.profile = profile;
		// `--expert` applies here too: the whole point of listing tools is to see
		// what the expert narrowed the set down to.
		if (values.expert !== undefined) command.expert = values.expert;
		return command;
	}
	if (values.doctor) return { kind: "doctor" };

	const thinking = values.thinking;
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
		throw new Error(`Invalid thinking level "${thinking}". Expected one of: ${THINKING_LEVELS.join(", ")}`);
	}

	const options: CliOptions = { json: values.json === true, tui: values.tui === true, yes: values.yes === true };
	// Rejected rather than silently ignored: a typo in a tier name would
	// otherwise leave the gate at its default while the user believes they
	// changed it — and the whole point of the gate is that its state is knowable.
	if (values.sandbox !== undefined) {
		if (!(SANDBOX_TIERS as readonly string[]).includes(values.sandbox)) {
			throw new Error(`--sandbox must be one of: ${SANDBOX_TIERS.join(", ")}`);
		}
		options.sandbox = values.sandbox as SandboxTier;
	}
	if (values.approval !== undefined) {
		if (!(APPROVAL_POLICIES as readonly string[]).includes(values.approval)) {
			throw new Error(`--approval must be one of: ${APPROVAL_POLICIES.join(", ")}`);
		}
		options.approval = values.approval as ApprovalPolicy;
	}
	if (values.profile !== undefined) options.profile = values.profile;
	if (values.expert !== undefined) options.expert = values.expert;
	if (values.model !== undefined) options.model = values.model;
	if (values.cwd !== undefined) options.cwd = values.cwd;
	if (thinking !== undefined) options.thinking = thinking as ThinkingLevel;
	const prompt = positionals.join(" ").trim();
	if (prompt.length > 0) options.prompt = prompt;
	return options;
}

function printHelp(): void {
	process.stdout.write(`${USAGE}\n`);
}

function printProfiles(): void {
	process.stdout.write(`${bold("Profiles")}\n`);
	for (const profile of listProfiles()) {
		process.stdout.write(`  ${cyan(profile.id.padEnd(10))} ${profile.description}\n`);
	}
	process.stdout.write(`\n${dim("Select with --profile <id>.")}\n`);
}

function printProviders(): void {
	process.stdout.write(`${bold("Providers")}\n`);
	for (const preset of PROVIDER_PRESETS) {
		const present = (process.env[preset.envVar] ?? "").trim().length > 0;
		const mark = present ? green("[x]") : dim("[ ]");
		process.stdout.write(
			`  ${mark} ${preset.id.padEnd(18)} ${preset.envVar.padEnd(26)} default: ${preset.defaultModel}\n`,
		);
	}
}

async function printTools(profileId: string | undefined, expertId: string | undefined, cwd: string): Promise<void> {
	const id = profileId ?? loadSettings().mode ?? "general";
	const profile = getProfile(id);
	const expert = expertId === undefined ? undefined : getExpert(expertId, cwd);

	// The same narrowing the session applies, so this is a truthful preview of
	// what a session would actually expose rather than the mode's raw set.
	const selection = narrowTools(await profile.tools({ cwd }), expert);

	const suffix = expert ? ` + expert "${expert.id}"` : "";
	process.stdout.write(`${bold(`Tools for mode "${profile.id}"${suffix}`)} ${dim(`(cwd: ${cwd})`)}\n`);
	if (selection.tools.length === 0) {
		process.stdout.write(`  ${dim("(none)")}\n`);
	}
	for (const tool of selection.tools) {
		process.stdout.write(`  ${cyan(tool.name.padEnd(14))} ${tool.description}\n`);
	}
	if (selection.unavailable.length > 0) {
		process.stdout.write(
			`\n${yellow("The expert asked for tools this mode does not provide:")} ${selection.unavailable.join(", ")}\n`,
		);
	}
	process.stdout.write(`\n${dim(`${selection.tools.length} tool(s).`)}\n`);
}

function printExperts(cwd: string): void {
	const catalog = loadExperts(cwd);
	process.stdout.write(`${bold("Experts")}\n`);
	if (catalog.experts.length === 0) {
		process.stdout.write(`  ${dim("(none)")}\n`);
	}
	for (const expert of catalog.experts) {
		const narrows = expert.tools ? dim(`  tools: ${expert.tools.join(", ")}`) : "";
		process.stdout.write(`  ${cyan(expert.id.padEnd(18))} ${expert.description}${narrows}\n`);
	}
	if (catalog.errors.length > 0) {
		process.stdout.write(`\n${red("Some expert files could not be loaded:")}\n`);
		for (const error of catalog.errors) process.stdout.write(`  ${error}\n`);
	}
	// Printed because "where do I put my own expert" is otherwise a mystery, and
	// the project-level path depends on the working directory.
	process.stdout.write(`\n${dim("Select with --expert <id>. An expert can only narrow the mode's tools.")}\n`);
	process.stdout.write(`${dim("Looked in:")}\n`);
	for (const dir of [projectExpertsDir(cwd), expertsDir()]) {
		process.stdout.write(`  ${dim(`${dir}/<id>.md`)}\n`);
	}
}

/** Locate a pi-managed binary, or return undefined when it has not been fetched. */
function findManagedBinary(binDir: string, name: string): string | undefined {
	const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
	return candidates.map((file) => join(binDir, file)).find((path) => existsSync(path));
}

/**
 * Run a managed binary and report its version line.
 *
 * Existence is not the same as working: a truncated download or a binary for
 * the wrong architecture sits there looking fine until a tool tries to exec it,
 * and then the failure surfaces as an empty search result rather than an error.
 * Running it is the only way to tell the two apart.
 */
function managedBinaryVersion(path: string): string | undefined {
	const result = spawnSync(path, ["--version"], { encoding: "utf-8", timeout: 5000 });
	if (result.error || result.status !== 0) return undefined;
	return (result.stdout ?? "").split("\n")[0]?.trim() || undefined;
}

function printDoctor(): void {
	const settings = loadSettings();
	const toolchain = toolchainPaths();
	process.stdout.write(`${bold("Environment")}\n`);
	process.stdout.write(`  project root : ${PROJECT_ROOT}\n`);
	// A bundled run has no pi source tree to point at: the sources are compiled
	// into the bundle. Reporting a path that does not exist would be a lie.
	const piSource = describePiSource();
	process.stdout.write(`  pi source    : ${IS_BUNDLED ? dim(piSource) : piSource}\n`);
	process.stdout.write(`  build        : ${IS_BUNDLED ? "bundle" : "sources (tsx)"}\n`);
	process.stdout.write(`  agent home   : ${AGENT_HOME}\n`);
	process.stdout.write(`  tool bin dir : ${toolchain.binDir}\n`);
	// A long conversation is pruned on its way to the model, so the transcript
	// on screen and the model's working set are not the same thing. Worth
	// stating outright rather than leaving to be discovered.
	process.stdout.write(`  context cap  : ${Math.round(CONTEXT_BUDGET_CHARS / 1024)} KB (older turns dropped from requests)\n`);
	process.stdout.write(`  node         : ${process.version}\n`);
	process.stdout.write(`  cwd          : ${process.cwd()}\n`);

	// ripgrep and fd back the grep and find tools. pi fetches them on first use,
	// so an empty bin dir is normal on a fresh machine but a dead end offline.
	process.stdout.write(`\n${bold("Managed binaries")}\n`);
	for (const name of ["rg", "fd"]) {
		const path = findManagedBinary(toolchain.binDir, name);
		if (!path) {
			process.stdout.write(`  ${dim("[ ]")} ${name.padEnd(14)} ${dim("not present; downloaded on first use")}\n`);
			continue;
		}
		const version = managedBinaryVersion(path);
		process.stdout.write(
			version
				? `  ${green("[x]")} ${name.padEnd(14)} ${version}\n`
				: `  ${red("[!]")} ${name.padEnd(14)} ${red(`${path} exists but does not run`)}\n`,
		);
	}

	process.stdout.write(`\n${bold("Settings")}\n`);
	for (const [key, value] of Object.entries(settings)) {
		// The policy is the one setting that is an object, so the generic
		// `value` would render as `[object Object]`. Shown with both the stored
		// keys and their meaning: the keys are what a user would edit by hand,
		// the gloss is what they would actually be choosing.
		const rendered =
			key === "permission" && settings.permission
				? `${settings.permission.tier} · ${settings.permission.approval}  ${dim(`(${describePolicy(settings.permission)})`)}`
				: (value ?? dim("(unset)"));
		process.stdout.write(`  ${key.padEnd(14)} ${rendered}\n`);
	}

	// The recipe is shown resolved rather than raw, because a stored expert id
	// that no longer resolves is otherwise only discoverable by trying to start
	// a session — and the failure looks like the model misbehaving.
	const catalog = loadExperts(process.cwd());
	process.stdout.write(`\n${bold("Recipe")}\n`);
	process.stdout.write(`  mode           ${settings.mode ?? "general"}\n`);
	const wanted = settings.expert;
	if (wanted === undefined) {
		process.stdout.write(`  expert         ${dim("(none)")}\n`);
	} else {
		const found = catalog.experts.find((expert) => expert.id === wanted);
		process.stdout.write(
			found
				? `  expert         ${found.label} ${dim(`(${found.source})`)}\n`
				: `  expert         ${red(`${wanted} - not found`)}\n`,
		);
	}
	process.stdout.write(`  experts known  ${catalog.experts.length}\n`);
	if (catalog.errors.length > 0) {
		process.stdout.write(`\n${red("Expert files that could not be loaded:")}\n`);
		for (const error of catalog.errors) process.stdout.write(`  ${error}\n`);
	}

	process.stdout.write(`\n${bold("Credentials")}\n`);
	let anyPresent = false;
	for (const preset of PROVIDER_PRESETS) {
		const present = (process.env[preset.envVar] ?? "").trim().length > 0;
		if (present) anyPresent = true;
		const mark = present ? green("[x]") : dim("[ ]");
		process.stdout.write(`  ${mark} ${preset.label.padEnd(16)} ${preset.envVar}\n`);
	}
	if (!anyPresent) {
		process.stdout.write(`\n${yellow("No provider keys found.")} The agent cannot start without one.\n`);
	}
}

/** Render one normalized event as a human-readable line. */
function renderText(event: AgentEvent): void {
	switch (event.type) {
		case "text_delta":
			process.stdout.write(event.text);
			break;
		case "thinking_delta":
			process.stdout.write(dim(event.text));
			break;
		case "assistant_end":
			process.stdout.write("\n");
			break;
		case "tool_start":
			process.stdout.write(`${dim("  -> ")}${cyan(event.name)} ${dim(JSON.stringify(event.args ?? {}))}\n`);
			break;
		case "tool_end":
			process.stdout.write(`${dim("  <- ")}${event.isError ? red("error") : green("ok")} ${dim(event.name)}\n`);
			break;
		case "error":
			process.stderr.write(`${red("error:")} ${event.message}\n`);
			break;
		default:
			break;
	}
}

async function readStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8").trim();
	return text.length > 0 ? text : undefined;
}

/**
 * Hand off to the interactive UI. Returns the process exit code rather than
 * throwing, because the terminal has already been restored by the time a
 * failure surfaces and the user needs to read the reason on a clean screen.
 */
async function startTui(options: CliOptions): Promise<number> {
	const tuiOptions: Parameters<typeof runTui>[0] = {};
	if (options.profile !== undefined) tuiOptions.profile = options.profile;
	if (options.expert !== undefined) tuiOptions.expert = options.expert;
	if (options.model !== undefined) tuiOptions.model = options.model;
	if (options.cwd !== undefined) tuiOptions.cwd = options.cwd;
	if (options.thinking !== undefined) tuiOptions.thinkingLevel = options.thinking;

	try {
		await runTui(tuiOptions);
		return 0;
	} catch (error) {
		process.stderr.write(`${red("error:")} ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

async function main(): Promise<number> {
	let parsed: ReturnType<typeof parseCli>;
	try {
		parsed = parseCli(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${red("error:")} ${error instanceof Error ? error.message : String(error)}\n\n`);
		printHelp();
		return 2;
	}

	if ("kind" in parsed) {
		switch (parsed.kind) {
			case "help":
				printHelp();
				return 0;
			case "list-profiles":
				printProfiles();
				return 0;
			case "list-experts":
				printExperts(process.cwd());
				return 0;
			case "list-providers":
				printProviders();
				return 0;
			case "list-tools":
				await printTools(parsed.profile, parsed.expert, process.cwd());
				return 0;
			case "doctor":
				printDoctor();
				return 0;
		}
	}

	const stdinPrompt = await readStdin();
	const prompt = parsed.prompt ?? stdinPrompt;
	if (!prompt) {
		// No prompt and an interactive terminal means the user wants the UI, not
		// a usage dump. `--json` is a scripting contract, so it never opens one.
		if (!parsed.json && (parsed.tui || canRunTui())) return startTui(parsed);

		process.stderr.write(`${red("error:")} no prompt given.\n\n`);
		printHelp();
		return 2;
	}

	const settings = loadSettings();
	const recipe: RecipeRequest = {};
	if (parsed.profile !== undefined) recipe.mode = parsed.profile;
	if (parsed.expert !== undefined) recipe.expert = parsed.expert;

	const sessionOptions: Parameters<typeof createAgent>[0] = { settings, recipe };
	if (parsed.model !== undefined) sessionOptions.model = parsed.model;
	if (parsed.cwd !== undefined) sessionOptions.cwd = parsed.cwd;
	if (parsed.thinking !== undefined) sessionOptions.thinkingLevel = parsed.thinking;

	// Assembled field by field rather than spread: a spread would let an
	// omitted flag overwrite the stored value with `undefined`, which reads as
	// "the user turned this off" when they said nothing at all.
	const stored = settings.permission ?? DEFAULT_PERMISSION_POLICY;
	sessionOptions.permission = { tier: parsed.sandbox ?? stored.tier, approval: parsed.approval ?? stored.approval };
	// `--yes` answers every ask with yes. It is an explicit act rather than a
	// default because the safe reading of an unanswered ask is "no".
	if (parsed.yes) sessionOptions.approver = async () => true;

	const session = await createAgent(sessionOptions);

	if (!parsed.json) {
		const expert = session.expert ? ` + ${session.expert.label}` : "";
		// The policy goes on the status line because it changes what the agent
		// can do, and a limit nobody can see is indistinguishable from a bug
		// when the agent stops doing something.
		const auto = parsed.yes ? "（自动允许）" : "";
		process.stderr.write(
			`${dim(`${session.profile.label}${expert} · ${session.model.provider}/${session.model.id} · ${session.cwd} · ${describePolicy(session.policy)}${auto}`)}\n`,
		);
		// Reported rather than swallowed: a tool the expert asked for that this
		// mode does not have looks like the expert silently not working, and the
		// cause is invisible from the outside.
		if (session.unavailableTools.length > 0) {
			process.stderr.write(
				`${yellow(`expert asked for tools this mode does not provide: ${session.unavailableTools.join(", ")}`)}\n`,
			);
		}
		process.stderr.write("\n");
	}

	session.subscribe((event) => {
		if (parsed.json) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		} else {
			renderText(event);
		}
	});

	try {
		await session.prompt(prompt);
	} finally {
		session.dispose();
	}
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		process.stderr.write(`${red("fatal:")} ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
