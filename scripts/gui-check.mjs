/**
 * GUI smoke test.
 *
 * Launches the real app the way a user does — `electron .`, resolving the entry
 * from package.json — and drives it over the Chrome DevTools Protocol: it sends
 * a message, waits for the run to finish, reads the rendered DOM back, then
 * restarts the app to check the conversation came back.
 *
 * It has to work this way. Running the assertions inside Electron as
 * `electron scripts/gui-check.js` looks simpler, but it changes module
 * resolution: from a loose script, `require("electron")` resolves to the
 * `electron` package in node_modules, which exports the *path to the binary*
 * rather than the API. The symptom is baffling — `app` is undefined, or a named
 * import "does not provide an export named 'BrowserWindow'" — and it does not
 * affect the shipped app at all, because Electron installs the real module when
 * it starts a proper app. Driving the app from outside tests what actually
 * ships, and cannot be fooled by that.
 *
 * The run is driven by the scripted transport (`GDOU_SCRIPTED_RUN=1`), so the
 * whole thing needs no API key and no network. That matters: streaming text and
 * a tool call filling with output are the parts of a chat interface most likely
 * to break silently, and they only exist during a run.
 *
 * The app is given a throwaway `GDOU_AGENT_HOME`, so the check never reads or
 * destroys the conversation a real user has stored. pi's own state directory is
 * left alone deliberately, so the managed-binary assertions still inspect the
 * one the installed app actually provisions into.
 *
 * Runs against the built output, so `npm run build` must have run first.
 *
 * Run with: npm run check:gui
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The `electron` package exports the path to its binary, which is exactly what
// a launcher needs.
const ELECTRON_BINARY = require("electron");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30_000;
const POLL_MS = 200;
const PROFILE = "general";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
	checks += 1;
	if (condition) {
		process.stdout.write(`  ok   ${label}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  FAIL ${label}${detail === undefined ? "" : ` -> ${detail}`}\n`);
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

/** Poll the DevTools endpoint until the renderer's page target shows up. */
async function waitForPage(port, exited) {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (exited()) throw new Error("the app exited before it opened a window");
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json`);
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page");
			if (page) return page;
		} catch {
			// Not listening yet.
		}
		await sleep(POLL_MS);
	}
	throw new Error("the app never opened a window");
}

/** Minimal CDP client: evaluate an expression in the page and return its value. */
function connect(page) {
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map();
	let nextId = 1;

	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.error) entry.reject(new Error(message.error.message));
		else if (message.result?.exceptionDetails) {
			entry.reject(new Error(message.result.exceptionDetails.exception?.description ?? "evaluation threw"));
		} else entry.resolve(message.result?.result?.value);
	});

	const ready = new Promise((resolveReady, rejectReady) => {
		socket.addEventListener("open", () => resolveReady());
		socket.addEventListener("error", () => rejectReady(new Error("could not attach to the page")));
	});

	// A renderer that dies takes its half of the conversation with it. Without
	// this, a request already in flight waits forever, and the check hangs on the
	// step that killed it instead of naming it — which is how "the settings page
	// froze the suite" was first observed: an unsettled top-level await, with no
	// line number that meant anything.
	socket.addEventListener("close", () => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			entry.reject(new Error("the page went away before answering"));
		}
	});

	return {
		async evaluate(expression) {
			await ready;
			const id = nextId++;
			return new Promise((resolveEval, rejectEval) => {
				pending.set(id, { resolve: resolveEval, reject: rejectEval });
				socket.send(
					JSON.stringify({
						id,
						method: "Runtime.evaluate",
						params: { expression, returnByValue: true, awaitPromise: true },
					}),
				);
			});
		},
		close() {
			socket.close();
		},
	};
}

/** Poll an expression until it satisfies `done`, or give up. */
async function waitFor(client, expression, done, description) {
	const deadline = Date.now() + TIMEOUT_MS;
	let last;
	while (Date.now() < deadline) {
		last = await client.evaluate(expression);
		if (done(last)) return last;
		await sleep(POLL_MS);
	}
	throw new Error(`timed out waiting for ${description} (last value: ${JSON.stringify(last)})`);
}

/**
 * Output of the most recently launched application instance.
 *
 * Kept at module scope so the outermost handler can attach it to any failure.
 * The main process's stderr is where Chromium says why a renderer died, and a
 * check that collects it but never prints it wastes the only evidence there is.
 */
let lastAppOutput = [];

/** Start the app and attach to it. */
async function launch(agentHome, extraEnv = {}, expectSession = true) {
	const port = await freePort();

	// NODE_OPTIONS is removed deliberately, not blanked. It is a Node-level
	// injection that runs before the app's entry point, and a `--require` hook
	// there can shadow the `electron` module: `require("electron")` then
	// resolves to the npm package, whose export is the *path to the binary*, so
	// `app` is undefined and the process dies on `app.isPackaged`. Electron
	// ignores most of NODE_OPTIONS in a packaged app, so this only ever bites
	// development runs — exactly the kind this check performs.
	//
	// ELECTRON_RUN_AS_NODE is removed for the same reason and is the same class
	// of leak. When it is set, electron.exe does not start Electron at all: it
	// runs as a plain Node process. `require("electron")` then returns the npm
	// package, which exports the path to the binary, so `app` is undefined and
	// the app dies before it opens a window — surfacing here as the opaque
	// "the app exited before it opened a window". Any Electron-based host
	// (an editor, or the agent harness this check runs under) exports it, so it
	// arrives from the environment rather than from anything in this repo.
	//
	// Deleting the keys matters: an empty string still counts as "set" and
	// reproduces the failure, which makes the fix look like it does not work.
	const env = { ...process.env, GDOU_SCRIPTED_RUN: "1", GDOU_AGENT_HOME: agentHome, ...extraEnv };
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;

	// `--disable-gpu` because this check has no opinion about how the pixels were
	// produced: it drives the interface over CDP and reads the DOM back. Left on,
	// the check inherits a dependency on the host's GPU stack, and on a machine
	// where the GPU process cannot start the failure surfaces as
	// `FAIL Target crashed` on the very first launch — which reads as a broken
	// application and sends the reader hunting through their own diff. Seen for
	// real: the same build passed 164/164 and then crashed six times in a row,
	// with `GPU process isn't usable. Goodbye.` on stderr.
	const app = spawn(
		ELECTRON_BINARY,
		[
			".",
			`--remote-debugging-port=${port}`,
			"--disable-gpu",
			"--disable-gpu-compositing",
			"--disable-gpu-sandbox",
			"--disable-software-rasterizer",
			"--no-sandbox",
		],
		{
			cwd: ROOT,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	const output = [];
	let exited = false;
	lastAppOutput = output;
	app.stdout.on("data", (chunk) => output.push(String(chunk)));
	app.stderr.on("data", (chunk) => output.push(String(chunk)));
	app.on("exit", () => {
		exited = true;
	});

	// The application's own output is the only evidence about why it did not come
	// up, and it is collected two lines up. Discarding it leaves the reader with
	// an opaque "Target crashed" or "never opened a window", which is the kind of
	// message that sends someone hunting through their own diff for a fault that
	// is not there.
	const page = await waitForPage(port, () => exited).catch((error) => {
		const log = output.join("").trim();
		throw new Error(`${error.message}\n--- application output ---\n${log || "(nothing on stdout or stderr)"}`);
	});
	const client = connect(page);

	// Two readiness signals, in order, because the obvious one is wrong: the
	// status line starts as an empty string, and an empty string does not
	// contain "未启动", so waiting on that text alone returns immediately and
	// the next assertion reads a DOM that has not been built yet.
	await waitFor(
		client,
		"document.getElementById('profile')?.options?.length ?? 0",
		(count) => Number(count) >= 1,
		"the profile picker to populate",
	);

	// A launch without credentials is expected to fail at this point, and the
	// failure is what is under test — waiting for a session that cannot start
	// would just time out.
	if (expectSession) {
		await waitFor(
			client,
			"document.getElementById('status-text')?.textContent ?? ''",
			(value) => typeof value === "string" && value.length > 0 && !value.includes("未启动"),
			"the session to start",
		);
	}

	// The app spawns renderer and GPU children; kill the tree, not just the
	// parent, or the port stays held and the next launch fails to attach.
	const stop = () =>
		new Promise((resolveKill) => {
			const killer = spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
			killer.on("exit", () => resolveKill());
			killer.on("error", () => resolveKill());
		});

	return { port, client, output, stop, page };
}

/** Read the whole rendered screen back as plain text plus a few lookups. */
const READ_DIAGNOSTICS = `(() => {
	const text = (id) => document.getElementById(id)?.textContent ?? "";
	const rows = (id) => {
		const dl = document.getElementById(id);
		if (!dl) return [];
		const dts = [...dl.querySelectorAll("dt")].map((n) => n.textContent);
		const dds = [...dl.querySelectorAll("dd")].map((n) => n.textContent);
		return dts.map((label, i) => [label, dds[i] ?? ""]);
	};
	return {
		status: text("status"),
		statusClass: document.getElementById("status")?.className ?? "",
		versions: rows("versions"),
		paths: rows("paths"),
		binaries: rows("binaries"),
		models: rows("models"),
		credentials: text("credentials"),
		agent: text("agent"),
		agentClass: document.getElementById("agent")?.className ?? "",
		profileIds: [...document.querySelectorAll("#profiles .name")].map((n) => n.textContent),
		bodyLength: document.body.innerText.length,
	};
})()`;

/** The transcript's rendered shape, as the assertions care about it. */
const READ_TRANSCRIPT = `(() => {
	const stream = document.getElementById("stream");
	const tool = document.querySelector(".tool");
	const body = document.querySelector(".tool-body");
	return {
		text: stream.innerText,
		userText: document.querySelector(".msg-user .body")?.textContent ?? "",
		userCount: document.querySelectorAll(".msg-user").length,
		assistantText: [...document.querySelectorAll(".msg-assistant .body")].map((n) => n.textContent).join(" | "),
		toolCount: document.querySelectorAll(".tool").length,
		toolName: document.querySelector(".tool-name")?.textContent ?? "",
		toolState: document.querySelector(".tool-state")?.textContent ?? "",
		toolOutput: body?.textContent?.trim() ?? "",
		toolOpen: tool?.classList.contains("open") ?? false,
		toolBodyVisible: (body?.offsetHeight ?? 0) > 0,
		// The empty state stays in the DOM and is toggled via the hidden
		// property, so its presence says nothing — only its visibility does.
		emptyShown: !(document.getElementById("empty")?.hidden ?? true),
		messageCount: document.querySelectorAll("#stream .msg").length,
		statusLine: document.getElementById("status-text")?.textContent ?? "",
	};
})()`;

/**
 * Open the history menu, closing it first when it is already open.
 *
 * The toggle is a toggle, and the menu keeps its previous rows while hidden —
 * so clicking it blindly can close a menu that the caller meant to refresh, and
 * the row count that follows would be a stale one.
 */
async function openHistory(client) {
	const alreadyOpen = await client.evaluate("!document.getElementById('history-menu').hidden");
	if (alreadyOpen) {
		await client.evaluate("document.getElementById('history-toggle').click()");
		await waitFor(
			client,
			"document.getElementById('history-menu').hidden",
			(hidden) => hidden === true,
			"the history menu to close",
		);
	}
	await client.evaluate("document.getElementById('history-toggle').click()");
}

function row(rows, label) {
	return rows.find(([name]) => name === label)?.[1] ?? "";
}

async function main() {
	// A throwaway home: the check must never touch a real conversation.
	const sandbox = await mkdtemp(join(tmpdir(), "gdou-check-"));
	const agentHome = join(sandbox, ".gdou-agent");
	const sessionsDir = join(agentHome, "sessions");
	const settingsFile = join(agentHome, "settings.json");

	/** Stored conversation files, newest first is not guaranteed here. */
	const sessionFiles = () => {
		try {
			return readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
		} catch {
			return [];
		}
	};

	/** The summary line of a stored conversation, which is all a list reads. */
	const summaryOf = (name) => JSON.parse(readFileSync(join(sessionsDir, name), "utf-8").split("\n")[0]);

	try {
		// ------------------------------------------------- first launch

		process.stdout.write("first launch\n");
		const first = await launch(agentHome);
		let client = first.client;

		const initial = await client.evaluate(`(() => ({
			empty: !(document.getElementById("empty")?.hidden ?? true),
			emptyHint: document.getElementById("empty-hint")?.textContent ?? "",
			statusLine: document.getElementById("status-text")?.textContent ?? "",
			profiles: [...document.getElementById("profile").options].map((o) => o.value),
			inputPresent: !!document.getElementById("input"),
			sendPresent: !!document.getElementById("send"),
			newChatPresent: !!document.getElementById("new-chat"),
			diagnosticsHidden: document.getElementById("diagnostics").hidden,
		}))()`);

		check("empty state is shown before anything is sent", initial.empty, String(initial.empty));
		check("mode picker is populated", initial.profiles.length >= 2, initial.profiles.join(", "));
		check("composer is present", initial.inputPresent && initial.sendPresent);
		check("new-conversation control is present", initial.newChatPresent);
		check("diagnostics start hidden", initial.diagnosticsHidden, String(initial.diagnosticsHidden));
		check("status line names the profile", initial.statusLine.includes(PROFILE), initial.statusLine);
		check("scripted run is disclosed in the status line", initial.statusLine.includes("脚本化运行"), initial.statusLine);
		check("no conversation is restored on a clean home", !initial.statusLine.includes("已恢复"), initial.statusLine);
		check("empty hint explains the scripted run", initial.emptyHint.includes("脚本化"), initial.emptyHint);
		// The indicator is deliberately absent while nothing is hidden: an
		// always-present badge becomes furniture and stops being read.
		check("no context indicator while nothing is hidden", !initial.statusLine.includes("模型可见"), initial.statusLine);

		// ------------------------------------------------------- one run

		process.stdout.write("\ntranscript\n");
		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "你好";
			document.getElementById("composer").requestSubmit();
		})()`);

		// user message, assistant, tool, closing assistant
		await waitFor(
			client,
			"document.querySelectorAll('#stream .msg').length",
			(count) => Number(count) >= 4,
			"the scripted run to render",
		);
		await waitFor(
			client,
			"document.getElementById('abort')?.hidden ?? true",
			(hidden) => hidden === true,
			"the run to finish",
		);

		const transcript = await client.evaluate(READ_TRANSCRIPT);

		check("empty state is replaced by the transcript", !transcript.emptyShown, String(transcript.emptyShown));
		check("user message is rendered verbatim", transcript.userText.includes("你好"), transcript.userText);
		check(
			"assistant text streamed in",
			transcript.assistantText.includes("脚本化运行"),
			transcript.assistantText.slice(0, 120),
		);
		check(
			"assistant closing text arrived",
			transcript.assistantText.includes("工具执行完毕"),
			transcript.assistantText.slice(0, 200),
		);
		check("tool call is shown by name", transcript.toolName === "current_time", transcript.toolName);
		check("tool call reports completion", transcript.toolState === "完成", transcript.toolState);

		// The tool ran for real: `current_time` returns a formatted timestamp.
		check("tool produced real output", transcript.toolOutput.length > 10, transcript.toolOutput.slice(0, 120));

		// ------------------------------------------------------ tool grouping

		process.stdout.write("\ntool grouping\n");

		const grouped = await client.evaluate(`(() => {
			const group = document.querySelector(".tool-group");
			return {
				present: !!group,
				folded: group ? !group.classList.contains("open") : null,
				bodyHidden: group ? group.querySelector(".tool-group-body").offsetHeight === 0 : null,
				count: group?.querySelector(".tool-group-count")?.textContent ?? "",
				label: group?.querySelector(".tool-group-label")?.textContent ?? "",
				inside: group ? group.querySelectorAll(".tool").length : 0,
			};
		})()`);
		check("consecutive tool calls form a group", grouped.present === true);
		check("the group holds both calls", grouped.inside === 2, String(grouped.inside));
		// Folded once the turn ends, so a long run does not push the conversation
		// off the screen — which is the whole point of grouping.
		check("a finished group is folded", grouped.folded === true, String(grouped.folded));
		check("the folded body is hidden", grouped.bodyHidden === true, String(grouped.bodyHidden));
		check("the group counts its calls", grouped.count.includes("2"), grouped.count);
		check("the group names its tools", grouped.label.length > 0, grouped.label);

		const groupOpened = await client.evaluate(`(() => {
			document.querySelector(".tool-group-head").click();
			const group = document.querySelector(".tool-group");
			return {
				open: group.classList.contains("open"),
				bodyVisible: group.querySelector(".tool-group-body").offsetHeight > 0,
				toolsInside: group.querySelectorAll(".tool").length,
			};
		})()`);
		check("clicking the group opens it", groupOpened.open === true, String(groupOpened.open));
		check("opening reveals the tool rows", groupOpened.bodyVisible === true, String(groupOpened.bodyVisible));
		check("both calls are still in the document", groupOpened.toolsInside === 2, String(groupOpened.toolsInside));

		process.stdout.write("\ntool disclosure\n");
		check("tool output starts collapsed", transcript.toolOpen === false, String(transcript.toolOpen));
		check("collapsed output is not visible", transcript.toolBodyVisible === false, String(transcript.toolBodyVisible));

		// The group was folded by the end of the turn, so reaching a tool row
		// means opening the group first. The check does what a user does rather
		// than clicking something that is not on screen.
		const expanded = await client.evaluate(`(() => {
			document.querySelector(".tool-group:not(.open) .tool-group-head")?.click();
			document.querySelector(".tool-head").click();
			const tool = document.querySelector(".tool");
			const body = document.querySelector(".tool-body");
			return {
				open: tool.classList.contains("open"),
				bodyVisible: body.offsetHeight > 0,
				caret: document.querySelector(".tool-caret").textContent,
				output: body.textContent.trim(),
			};
		})()`);

		check("clicking expands the tool call", expanded.open === true, String(expanded.open));
		check("expanded output becomes visible", expanded.bodyVisible === true, String(expanded.bodyVisible));
		check("caret reflects the expanded state", expanded.caret === "▾", expanded.caret);
		check("expanded output holds the tool result", expanded.output.length > 10, expanded.output.slice(0, 120));

		// ------------------------------------------------------ persistence

		process.stdout.write("\npersistence\n");
		const afterFirstRun = sessionFiles();
		check("conversation was written to disk", afterFirstRun.length === 1, afterFirstRun.join(", "));

		if (afterFirstRun.length === 1) {
			const summary = summaryOf(afterFirstRun[0]);
			check("stored session is identified", typeof summary.id === "string" && summary.id.length > 0, summary.id);
			check("stored session belongs to the profile", summary.profile === PROFILE, String(summary.profile));
			check("stored session holds the conversation", summary.messageCount >= 4, String(summary.messageCount));

			// The title comes from the first user message, which is what makes a
			// session list readable without opening anything.
			check("summary carries a title from the user message", summary.title === "你好", String(summary.title));

			// Listing reads only the first line, so that line has to stand on
			// its own — a summary that needed the rest of the file would defeat
			// the point.
			const lines = readFileSync(join(sessionsDir, afterFirstRun[0]), "utf-8").split("\n");
			check("file is a summary line followed by a record", lines.length >= 3, `${lines.length} lines`);
			check(
				"the summary line alone is enough to list",
				typeof summary.updatedAt === "string" && summary.updatedAt.length > 0,
				summary.updatedAt,
			);
		}

		client.close();
		await first.stop();
		await sleep(1500);

		// ------------------------------------------------- second launch

		process.stdout.write("\nrestart\n");
		// The budget is lowered for this launch so the pruning path can be
		// exercised without first building a megabyte of conversation.
		const second = await launch(agentHome, { GDOU_CONTEXT_BUDGET: "800" });
		client = second.client;

		// Opening the app defaults to a fresh conversation; the previous one is
		// not dragged back onto the screen. Persistence is still what it always
		// was — the file is on disk and reachable one click away — but the
		// default is a blank composer, so that is what is asserted here before
		// reopening the stored conversation to prove the history survived.
		const fresh = await client.evaluate(READ_TRANSCRIPT);
		check("a fresh launch opens a new conversation, not the old one", fresh.emptyShown === true, String(fresh.emptyShown));
		check("the stored conversation is still on disk", sessionFiles().length === 1, sessionFiles().join(", "));

		// The history did not vanish with the default change — it is opened
		// explicitly, which is the path the "restart" assertions used to cover
		// implicitly when the app reopened it for them.
		const storedId = await client.evaluate(
			"window.gdou.listSessions('general').then((s) => s[0]?.id)",
		);
		await client.evaluate(`window.gdou.openSession(${JSON.stringify(storedId)})`);
		await waitFor(
			client,
			"document.querySelector('.msg-user .body')?.textContent ?? ''",
			(value) => value === "你好",
			"the stored conversation to reopen",
		);

		const restored = await client.evaluate(READ_TRANSCRIPT);
		check("user message came back", restored.userText.includes("你好"), restored.userText);
		check("assistant text came back", restored.assistantText.includes("脚本化运行"), restored.assistantText.slice(0, 120));
		check("closing text came back", restored.assistantText.includes("工具执行完毕"), restored.assistantText.slice(0, 200));
		// `>= 1` rather than an exact count: what is being checked is that the
		// calls survived the restart, and the number of them is the scripted
		// run's business, not this assertion's.
		check("tool call came back", restored.toolCount >= 1, String(restored.toolCount));
		check("tool call kept its name", restored.toolName === "current_time", restored.toolName);
		check("tool call kept its outcome", restored.toolState === "完成", restored.toolState);
		check("tool output survived the restart", restored.toolOutput.length > 10, restored.toolOutput.slice(0, 120));
		check("message count matches the stored session", restored.userCount === 1, String(restored.userCount));
		check("status line reports the restore", restored.statusLine.includes("已恢复"), restored.statusLine);

		// ------------------------------------------------ context notice

		// Pruning is invisible by construction: the model simply stops being
		// shown old turns. Without a notice the only symptom is a model that
		// quietly forgets, so the notice is part of the feature and is asserted
		// here rather than assumed to render.
		process.stdout.write("\ncontext notice\n");
		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "第三个问题";
			document.getElementById("composer").requestSubmit();
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('.notice-block').length",
			(count) => Number(count) >= 1,
			"the pruning notice to appear",
		);

		const notice = await client.evaluate("document.querySelector('.notice-block')?.textContent ?? ''");
		check("a notice explains that the model was pruned", notice.includes("上下文"), notice.slice(0, 60));
		check("the notice says the record is unaffected", notice.includes("记录"), notice.slice(0, 60));
		check("the notice is not styled as an error", !notice.includes("失败"), notice.slice(0, 60));

		// The notice scrolls away; the indicator is what remains answerable at
		// any moment. It updates when the run ends — after the notice, which is
		// raised mid-request — so this waits rather than reading immediately.
		const indicator = await waitFor(
			client,
			"document.getElementById('status-text').textContent",
			(value) => typeof value === "string" && value.includes("模型可见"),
			"the context indicator to appear",
		);
		const split = /模型可见 (\d+)\/(\d+) 条/.exec(String(indicator));
		check(
			"the indicator reports a real split",
			split !== null && Number(split[1]) < Number(split[2]),
			String(indicator),
		);

		// The point of pruning on the way to the provider: what the user can
		// scroll back through is untouched.
		const afterPruning = await client.evaluate(READ_TRANSCRIPT);
		check(
			"the transcript keeps turns the model can no longer see",
			afterPruning.userCount >= 2,
			`${afterPruning.userCount} user message(s)`,
		);
		check("tool calls remain in the transcript", afterPruning.toolCount >= 1, `${afterPruning.toolCount} tool call(s)`);

		// -------------------------------------------- working directory

		// The OS folder picker cannot be driven from a check — it is modal and
		// has no scriptable interface. So the work is split: the dialog only
		// reports a path, and everything that matters (validating, storing,
		// rebuilding the session, redrawing) happens in `setCwd`, which is
		// exercised here directly.
		process.stdout.write("\nworking directory\n");
		const cwdControl = await client.evaluate(`(() => ({
			text: document.getElementById("cwd")?.textContent ?? "",
			disabled: document.getElementById("cwd")?.disabled ?? true,
		}))()`);
		check("directory control names the session directory", cwdControl.text.length > 0, cwdControl.text);
		check("directory control is usable", cwdControl.disabled === false, String(cwdControl.disabled));

		const workDir = join(sandbox, "work");
		await mkdir(workDir, { recursive: true });

		const switched = await client.evaluate(
			`window.gdou.setCwd(${JSON.stringify(workDir)}).then(() => "ok").catch((error) => "ERR: " + error.message)`,
		);
		check("adopting a directory is accepted", switched === "ok", switched);

		// The window redraws from the announcement the main process sends, not
		// from the call site, so this also proves the broadcast reaches it.
		const updatedCwd = await waitFor(
			client,
			"document.getElementById('cwd')?.textContent ?? ''",
			(value) => typeof value === "string" && value.endsWith("work"),
			"the directory control to update",
		);
		check("directory control followed the change", String(updatedCwd).endsWith("work"), String(updatedCwd));

		const settingsFile = join(agentHome, "settings.json");
		const storedSettings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf-8") : "";
		check("chosen directory was stored", storedSettings.includes("work"), settingsFile);
		check("settings stayed valid JSON", (() => {
			try {
				JSON.parse(storedSettings);
				return true;
			} catch {
				return false;
			}
		})(), storedSettings.slice(0, 80));

		const afterSwitch = await client.evaluate(READ_TRANSCRIPT);
		check("conversation survived the directory change", afterSwitch.userText.includes("你好"), afterSwitch.userText);
		check("tool calls survived the directory change", afterSwitch.toolCount >= 1, `${afterSwitch.toolCount} tool call(s)`);

		const rejected = await client.evaluate(
			`window.gdou.setCwd(${JSON.stringify(join(sandbox, "not-a-directory"))}).then(() => "ACCEPTED").catch(() => "REJECTED")`,
		);
		check("a path that is not a directory is rejected", rejected === "REJECTED", rejected);

		const afterRejection = await client.evaluate("document.getElementById('cwd').textContent");
		check("a rejected path leaves the directory unchanged", afterRejection.endsWith("work"), afterRejection);

		// -------------------------------------------------- clear + diagnostics

		process.stdout.write("\nnew conversation\n");
		await client.evaluate("document.getElementById('new-chat').click()");
		// The empty state lives inside #stream, so "is the stream empty" is the
		// wrong question. Count messages instead.
		await waitFor(
			client,
			"document.querySelectorAll('#stream .msg').length",
			(count) => Number(count) === 0,
			"the transcript to clear",
		);

		const cleared = await client.evaluate(`(() => ({
			emptyShown: !(document.getElementById("empty")?.hidden ?? true),
			messageCount: document.querySelectorAll("#stream .msg").length,
			statusLine: document.getElementById("status-text").textContent,
		}))()`);
		check("clearing brings back the empty state", cleared.emptyShown, String(cleared.emptyShown));
		check("clearing leaves no messages behind", cleared.messageCount === 0, String(cleared.messageCount));
		check("clearing drops the restore note", !cleared.statusLine.includes("已恢复"), cleared.statusLine);

		// The point of the whole feature: starting a new topic must not destroy
		// the previous one. Before this, it did.
		check("the previous conversation survives", sessionFiles().length === 1, sessionFiles().join(", "));

		// ---------------------------------------------------- session list

		process.stdout.write("\nsession list\n");
		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "SECOND";
			document.getElementById("composer").requestSubmit();
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('#stream .msg').length",
			(count) => Number(count) >= 4,
			"the second run to render",
		);
		await waitFor(
			client,
			"document.getElementById('abort')?.hidden ?? true",
			(hidden) => hidden === true,
			"the second run to finish",
		);

		check("the second conversation is stored separately", sessionFiles().length === 2, sessionFiles().join(", "));

		const listed = await client.evaluate("window.gdou.listSessions('general').then((s) => s.map((x) => x.title))");
		check("both conversations are listed", listed.length === 2, JSON.stringify(listed));
		check("the newest is listed first", listed[0] === "SECOND", JSON.stringify(listed));
		check(
			"titles come from the user messages",
			listed.includes("你好") && listed.includes("SECOND"),
			JSON.stringify(listed),
		);

		await client.evaluate("document.getElementById('history-toggle').click()");
		await waitFor(
			client,
			"document.querySelectorAll('.menu-row').length",
			(count) => Number(count) === 2,
			"the history menu to fill",
		);
		const menu = await client.evaluate(`(() => ({
			hidden: document.getElementById("history-menu").hidden,
			items: [...document.querySelectorAll(".menu-row")].map((row) => row.textContent),
			marked: document.querySelectorAll(".menu-row.current").length,
		}))()`);
		check("history menu is open", menu.hidden === false, String(menu.hidden));
		check("history menu lists both conversations", menu.items.length === 2, String(menu.items.length));
		check("history menu marks the open one", menu.marked === 1, String(menu.marked));
		check(
			"history entries show a title",
			menu.items.some((text) => text.includes("你好")) && menu.items.some((text) => text.includes("SECOND")),
			menu.items.join(" | "),
		);

		// --------------------------------------------- reopening and deleting

		process.stdout.write("\nreopen and delete\n");
		const firstId = await client.evaluate(
			"window.gdou.listSessions('general').then((s) => s.find((x) => x.title === '你好').id)",
		);
		await client.evaluate(`window.gdou.openSession(${JSON.stringify(firstId)})`);
		await waitFor(
			client,
			"document.querySelector('.msg-user .body')?.textContent ?? ''",
			(value) => value === "你好",
			"the older conversation to open",
		);

		const reopened = await client.evaluate(READ_TRANSCRIPT);
		check("reopened conversation shows its own messages", reopened.userText.includes("你好"), reopened.userText);
		check("reopened conversation has its tool call", reopened.toolCount >= 1, `${reopened.toolCount} tool call(s)`);
		check("reopening does not create a file", sessionFiles().length === 2, sessionFiles().join(", "));

		const secondId = await client.evaluate(
			"window.gdou.listSessions('general').then((s) => s.find((x) => x.title === 'SECOND').id)",
		);
		await client.evaluate(`window.gdou.deleteSession(${JSON.stringify(secondId)})`);

		check("deleting removes the file", sessionFiles().length === 1, sessionFiles().join(", "));
		const remaining = await client.evaluate("window.gdou.listSessions('general').then((s) => s.map((x) => x.title))");
		check(
			"deleting removes it from the list",
			remaining.length === 1 && remaining[0] === "你好",
			JSON.stringify(remaining),
		);

		// ------------------------------------------------------- rename

		// Renaming has to reach disk, not just the menu: the title lives in the
		// summary line that listing reads, so a rename kept only in memory would
		// look right until the next launch.
		process.stdout.write("\nrename\n");
		await openHistory(client);
		await waitFor(
			client,
			"document.querySelectorAll('.menu-row').length",
			(count) => Number(count) === 1,
			"the history menu to fill",
		);

		await client.evaluate("document.querySelector('.menu-action').click()");
		await waitFor(
			client,
			"document.querySelector('.menu-input')?.value ?? ''",
			(value) => typeof value === "string" && value.length > 0,
			"the rename field to open",
		);
		const renameField = await client.evaluate(`(() => ({
			value: document.querySelector(".menu-input")?.value ?? "",
			titleGone: !document.querySelector(".menu-row .menu-title"),
		}))()`);
		check("the rename field starts from the current title", renameField.value === "你好", renameField.value);
		check("the title is replaced while editing", renameField.titleGone, String(renameField.titleGone));

		// An empty name is refused: clearing it would leave a row with nothing to
		// click, and no way to get the derived title back.
		await client.evaluate(`(() => {
			const input = document.querySelector(".menu-input");
			input.value = "   ";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('.menu-row .menu-title').length",
			(count) => Number(count) === 1,
			"the row to come back",
		);
		const afterEmpty = await client.evaluate("document.querySelector('.menu-title')?.textContent ?? ''");
		check("an empty rename keeps the old title", afterEmpty === "你好", afterEmpty);

		await client.evaluate("document.querySelector('.menu-action').click()");
		await waitFor(
			client,
			"document.querySelector('.menu-input')?.value ?? ''",
			(value) => typeof value === "string" && value.length > 0,
			"the rename field to reopen",
		);
		await client.evaluate(`(() => {
			const input = document.querySelector(".menu-input");
			input.value = "改过的标题";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		})()`);
		// Wait for the edit to close, then assert the title — waiting for the
		// title itself would make the assertion that follows a tautology.
		await waitFor(
			client,
			"document.querySelectorAll('.menu-input').length",
			(count) => Number(count) === 0,
			"the rename field to close",
		);
		const renamedTitle = await client.evaluate("document.querySelector('.menu-title')?.textContent ?? ''");
		check("the menu shows the new title", renamedTitle === "改过的标题", renamedTitle);

		// The list is built from the summary line on disk, so this is what proves
		// the rename was persisted rather than only redrawn.
		const relisted = await client.evaluate("window.gdou.listSessions('general').then((s) => s.map((x) => x.title))");
		check("the rename reached disk", relisted.length === 1 && relisted[0] === "改过的标题", JSON.stringify(relisted));

		const summaryLine = summaryOf(sessionFiles()[0]);
		check("the stored summary carries the new title", summaryLine.title === "改过的标题", String(summaryLine.title));
		check("renaming left the conversation alone", summaryLine.messageCount >= 4, String(summaryLine.messageCount));

		// ------------------------------------------------------------- shell

		process.stdout.write("\nshell\n");

		const chrome = await client.evaluate(`(() => ({
			controls: ["win-minimize", "win-maximize", "win-close"].every((id) => !!document.getElementById(id)),
			navViews: [...document.querySelectorAll("#primary-nav button")].map((b) => b.dataset.view),
			viewSections: [...document.querySelectorAll("#main > .view")].map((s) => s.id.replace("view-", "")),
			modes: [...document.querySelectorAll("#mode-switch button")].map((b) => b.dataset.mode),
			pickerModes: [...document.getElementById("profile").options].map((o) => o.value),
			activeMode: document.querySelector("#mode-switch button.active")?.dataset.mode ?? "",
			conversations: document.querySelectorAll("#conversation-list .conversation-row").length,
			collapsed: document.getElementById("shell").classList.contains("sidebar-collapsed"),
			titlebar: !!document.querySelector(".titlebar .titlebar-drag-region"),
		}))()`);
		check("window controls are present", chrome.controls === true, String(chrome.controls));
		check("the titlebar has a drag region", chrome.titlebar === true);
		// Asserted against the pages rather than a fixed number. The count was
		// written as "four" when there were four, and adding a page then meant
		// editing a constant here to keep a passing suite passing — which is the
		// same trap the mode-switch check below was written to avoid. What must
		// hold is that the sidebar offers every page, in the order they appear,
		// and invents none.
		check(
			"the sidebar lists every page and invents none",
			chrome.navViews.length > 0 && chrome.navViews.join(",") === chrome.viewSections.join(","),
			`nav [${chrome.navViews.join(", ")}] vs pages [${chrome.viewSections.join(", ")}]`,
		);
		// Asserted against the picker rather than a fixed count. Modes are files
		// anyone can add now, so "there are exactly two" is a statement about
		// this machine, not about the product — and a project that defines its
		// own modes would make it fail. What must hold is that the switch shows
		// the *first* modes, in the catalog's order, and invents none.
		check(
			"the mode switch mirrors the first modes of the picker",
			chrome.modes.length > 0 &&
				chrome.modes.length <= chrome.pickerModes.length &&
				chrome.modes.join(",") === chrome.pickerModes.slice(0, chrome.modes.length).join(","),
			`switch [${chrome.modes.join(", ")}] of picker [${chrome.pickerModes.join(", ")}]`,
		);
		check("the mode switch reflects the running mode", chrome.activeMode === PROFILE, chrome.activeMode);
		check(
			"the sidebar lists the stored conversations",
			chrome.conversations >= 1,
			`${chrome.conversations} row(s)`,
		);
		check("the sidebar starts expanded", chrome.collapsed === false, String(chrome.collapsed));

		await client.evaluate("document.getElementById('nav-toggle').click()");
		const collapsed = await client.evaluate("document.getElementById('shell').classList.contains('sidebar-collapsed')");
		check("the nav toggle collapses the sidebar", collapsed === true, String(collapsed));
		await client.evaluate("document.getElementById('nav-toggle').click()");

		// One turn, because the context numbers only exist once the model has been
		// shown something — and the sections above restart the session, which
		// clears them.
		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "再跑一轮";
			document.getElementById("composer").requestSubmit();
		})()`);
		await waitFor(
			client,
			"document.getElementById('abort')?.hidden ?? true",
			(hidden) => hidden === true,
			"the shell run to finish",
		);

		const inspector = await client.evaluate(`(() => ({
			session: document.getElementById("inspector-session").textContent,
			tools: [...document.querySelectorAll("#inspector-tools .tool-chip")].map((n) => n.textContent),
			hasBar: !!document.querySelector("#inspector-context .context-bar"),
			divider: !!document.getElementById("layout-divider"),
		}))()`);
		check("the inspector names the mode", inspector.session.includes(PROFILE), inspector.session.slice(0, 50));
		// Named rather than counted: the count changes whenever a mode gains a
		// tool, and an assertion that has to be edited each time stops being
		// read. What matters is that the list reflects the running mode.
		check(
			"the inspector lists the real tools",
			inspector.tools.length > 0 && inspector.tools.includes("current_time"),
			inspector.tools.join(", "),
		);
		check("the inspector shows a context bar after a request", inspector.hasBar === true, String(inspector.hasBar));
		check("the inspector is resizable", inspector.divider === true);
		// The row exists even when there is nothing to say. Its absence would be
		// invisible — the reader cannot tell "no fallback configured" from "this
		// build has no such feature" — and the disclosure only means anything if
		// the empty case is stated rather than omitted.
		check(
			"the inspector discloses the fallback model either way",
			inspector.session.includes("备用模型"),
			inspector.session.slice(0, 80),
		);

		// The theme choice has to survive a reload, so it is stored rather than
		// kept in memory.
		const themeBefore = await client.evaluate("document.documentElement.dataset.appTheme");
		await client.evaluate("document.getElementById('theme-toggle').click()");
		const themeAfter = await client.evaluate("document.documentElement.dataset.appTheme");
		check("the theme toggle flips the theme", themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`);
		check(
			"the theme choice is stored",
			(await client.evaluate("localStorage.getItem('gdou-theme')")) === themeAfter,
			String(themeAfter),
		);
		check(
			"the theme actually changes the shell",
			(await client.evaluate("getComputedStyle(document.querySelector('.sztu-shell')).backgroundColor")) !==
				(themeAfter === "dark" ? "rgb(247, 249, 250)" : "rgb(23, 25, 28)"),
			themeAfter,
		);
		await client.evaluate("document.getElementById('theme-toggle').click()");

		await client.evaluate("document.querySelector('[data-view=experts]').click()");
		const expertsView = await client.evaluate(`(() => ({
			chatHidden: document.getElementById("view-chat").hidden,
			expertsHidden: document.getElementById("view-experts").hidden,
			cards: document.querySelectorAll("#experts .expert-card").length,
			activeNav: document.querySelector("#primary-nav button.active")?.dataset.view ?? "",
		}))()`);
		check("switching to experts hides the conversation", expertsView.chatHidden === true);
		check("the experts view is shown", expertsView.expertsHidden === false);
		check("expert cards are rendered", expertsView.cards >= 3, `${expertsView.cards} card(s)`);
		check("the nav marks the active view", expertsView.activeNav === "experts", expertsView.activeNav);

		// The two features that are designed but not built say so, rather than
		// presenting an empty page that reads as broken.
		for (const [view, label] of [["automation", "自动化"], ["skills", "Skills"]]) {
			await client.evaluate(`document.querySelector('[data-view=${view}]').click()`);
			const page = await client.evaluate(`(() => ({
				hidden: document.getElementById("view-${view}").hidden,
				text: document.getElementById("view-${view}").textContent,
			}))()`);
			check(`${label} page is reachable`, page.hidden === false);
			check(`${label} page explains it is not built`, page.text.includes("还没做"), page.text.slice(0, 40));
		}

		await client.evaluate("document.querySelector('[data-view=chat]').click()");
		const backToChat = await client.evaluate(`(() => ({
			chatHidden: document.getElementById("view-chat").hidden,
			diagnosticsHidden: document.getElementById("diagnostics").hidden,
		}))()`);
		check("switching back restores the conversation", backToChat.chatHidden === false);
		check("the diagnostics panel is hidden again", backToChat.diagnosticsHidden === true);

		// -------------------------------------------------------- expert recipe

		// -------------------------------------------------- artifact delivery

		process.stdout.write("\nartifact delivery\n");

		// Delivery needs something real to hand over, so a file is placed in the
		// working directory first. The scripted run picks up whatever is there
		// rather than inventing a path — a card pointing at a file that does not
		// exist is exactly the failure this feature is meant to prevent.
		await writeFile(
			join(workDir, "report.html"),
			"<!doctype html><html><body><h1>示例产物</h1></body></html>",
			"utf-8",
		);

		// Delivery only exists where the mode can produce something, so this
		// switches to `coding`. Switching also rebuilds the session, which is
		// what lets the scripted run see the file just written.
		await client.evaluate(`(() => {
			const picker = document.getElementById("profile");
			picker.value = "coding";
			picker.dispatchEvent(new Event("change"));
		})()`);
		await waitFor(client, "document.getElementById('profile').value", (v) => v === "coding", "coding mode");
		await sleep(400);

		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "交付一个文件看看";
			document.getElementById("composer").requestSubmit();
		})()`);

		await waitFor(client, "document.querySelectorAll('.artifact').length", (n) => Number(n) >= 1, "artifact card");

		const delivered = await client.evaluate(`(() => {
			const card = document.querySelector(".artifact");
			return JSON.stringify({
				cards: document.querySelectorAll(".artifact").length,
				name: card?.querySelector(".artifact-name")?.textContent ?? "",
				meta: card?.querySelector(".artifact-meta")?.textContent ?? "",
				rows: document.querySelectorAll("#artifacts .artifact-row").length,
				rowName: document.querySelector("#artifacts .artifact-row__name")?.textContent ?? "",
			});
		})()`);
		const shown = JSON.parse(delivered);
		check("a delivered artifact renders as a card", shown.cards >= 1, `${shown.cards} card(s)`);
		check("the card names the file", shown.name.length > 0, shown.name);
		check("the card shows type and size", shown.meta.includes("·"), shown.meta);
		check("the inspector lists the artifact", shown.rows >= 1, `${shown.rows} row(s)`);
		check("the inspector row matches the card", shown.rowName === shown.name, shown.rowName);

		// The preview has to actually open — a card that does nothing when
		// clicked is the failure this whole feature exists to avoid.
		await client.evaluate("document.querySelector('.artifact').click()");
		await waitFor(client, "!!document.getElementById('inspector-artifact')", (v) => v === true, "artifact preview");
		const preview = await client.evaluate(`(() => {
			const box = document.getElementById("inspector-artifact");
			return JSON.stringify({
				title: box?.querySelector("b")?.textContent ?? "",
				hasBody: !!box?.querySelector("pre, iframe, img"),
			});
		})()`);
		const opened = JSON.parse(preview);
		check("clicking the card opens the preview", opened.title.length > 0, opened.title);
		check("the preview renders content", opened.hasBody === true);

		// A path the model never delivered must not be readable through the
		// preview channel — otherwise the renderer becomes a file-read
		// primitive and the permission gate is bypassed by asking the UI.
		const refused = await client.evaluate(
			`window.gdou.readArtifact("C:/Windows/System32/drivers/etc/hosts").then(() => "ALLOWED").catch(() => "REFUSED")`,
		);
		check("the preview channel refuses undelivered paths", refused === "REFUSED", String(refused));

		// Back to the mode the remaining sections assume.
		await client.evaluate(`(() => {
			const picker = document.getElementById("profile");
			picker.value = ${JSON.stringify(PROFILE)};
			picker.dispatchEvent(new Event("change"));
		})()`);
		await waitFor(client, "document.getElementById('profile').value", (v) => v === PROFILE, "back to general");
		await sleep(400);

		// ------------------------------------------------------- expert recipe

		process.stdout.write("\nexpert recipe\n");

		const picker = await client.evaluate(`(() => ({
			experts: [...document.getElementById("expert").options].map((o) => o.value),
			selected: document.getElementById("expert").value,
		}))()`);
		check("the expert picker offers a no-expert option", picker.experts[0] === "", picker.experts.join(", "));
		check("built-in experts are listed", picker.experts.includes("security-audit"), picker.experts.join(", "));
		check("no expert is selected by default", picker.selected === "", picker.selected);

		const expertCard = await client.evaluate("document.getElementById('experts').textContent");
		check(
			"the experts page lists them",
			String(expertCard).includes("security-audit"),
			String(expertCard).slice(0, 60),
		);

		const beforeExpert = await client.evaluate(`(() => ({
			status: document.getElementById("status-text").textContent,
			warningHidden: document.getElementById("expert-warning").hidden,
		}))()`);
		check("no expert warning while there is no expert", beforeExpert.warningHidden === true, String(beforeExpert.warningHidden));
		check("the status line has no expert segment", !beforeExpert.status.includes("安全审计"), beforeExpert.status);

		// general exposes none of the tools this expert asks for, which is the
		// point. An expert may only narrow, so the result is an empty tool set
		// rather than the file access it named — and that has to be said out
		// loud, because otherwise the agent simply stops using tools.
		await client.evaluate(`(() => {
			const picker = document.getElementById("expert");
			picker.value = "security-audit";
			picker.dispatchEvent(new Event("change"));
		})()`);

		await waitFor(
			client,
			"document.getElementById('status-text')?.textContent ?? ''",
			(value) => typeof value === "string" && value.includes("安全审计"),
			"the expert to be applied",
		);

		const withExpert = await client.evaluate(`(() => ({
			status: document.getElementById("status-text").textContent,
			warningHidden: document.getElementById("expert-warning").hidden,
			warning: document.getElementById("expert-warning").textContent,
		}))()`);
		check("the status line names the expert", withExpert.status.includes("安全审计"), withExpert.status);
		check("the expert narrowed the tool set to nothing", withExpert.status.includes("0 个工具"), withExpert.status);
		check("the unavailable tools are disclosed", withExpert.warningHidden === false, String(withExpert.warningHidden));
		check("the warning names the tools", withExpert.warning.includes("read"), withExpert.warning);

		// Choosing "no expert" has to mean none, not fall back to a stored
		// default — otherwise the option would be unusable for anyone who has
		// one configured.
		await client.evaluate(`(() => {
			const picker = document.getElementById("expert");
			picker.value = "";
			picker.dispatchEvent(new Event("change"));
		})()`);
		await waitFor(
			client,
			"document.getElementById('status-text')?.textContent ?? ''",
			(value) => typeof value === "string" && !value.includes("安全审计"),
			"the expert to be removed",
		);
		const withoutExpert = await client.evaluate(`(() => ({
			status: document.getElementById("status-text").textContent,
			warningHidden: document.getElementById("expert-warning").hidden,
			listed: document.querySelectorAll("#inspector-tools li").length,
		}))()`);
		// Asserted as agreement between the two views rather than against a
		// literal: the status line and the inspector must describe the same tool
		// set, and a hardcoded number would go stale without saying anything
		// about that.
		check(
			"removing the expert restores the tools",
			withoutExpert.listed > 0 && withoutExpert.status.includes(`${withoutExpert.listed} 个工具`),
			`status="${withoutExpert.status}" listed=${withoutExpert.listed}`,
		);
		check("the warning clears with the expert", withoutExpert.warningHidden === true, String(withoutExpert.warningHidden));

		process.stdout.write("\ndiagnostics\n");
		await client.evaluate("document.getElementById('diag-toggle').click()");
		await waitFor(
			client,
			"document.getElementById('status')?.textContent ?? ''",
			(value) => typeof value === "string" && value.length > 0 && !value.includes("正在读取"),
			"the diagnostics probe",
		);
		const screen = await client.evaluate(READ_DIAGNOSTICS);
		client.close();

		check(
			"status line resolved",
			screen.statusClass.includes("status--ok") || screen.statusClass.includes("status--warn"),
			screen.statusClass,
		);
		check("status line is not an error", !screen.statusClass.includes("status--bad"), screen.status);
		check("body actually rendered", screen.bodyLength > 200, `${screen.bodyLength} chars`);

		check("electron version present", /^\d+\./.test(row(screen.versions, "Electron")), row(screen.versions, "Electron"));
		check("node version present", /^\d+\./.test(row(screen.versions, "Node")), row(screen.versions, "Node"));

		const projectRoot = row(screen.paths, "项目根");
		check("project root points at the project", projectRoot.endsWith("gdou-agent"), projectRoot);
		check(
			"pi source reported as inlined",
			row(screen.paths, "pi 源码").includes("inlined"),
			row(screen.paths, "pi 源码"),
		);
		check("esbuild bundle flag is set", row(screen.paths, "esbuild 打包") === "是", row(screen.paths, "esbuild 打包"));
		check("agent home honours the override", row(screen.paths, "状态目录") === agentHome, row(screen.paths, "状态目录"));

		// pi resolves this directory from package metadata. Get it wrong and the
		// agent downloads ripgrep into another application's state, which
		// produces no error at all — just files in the wrong place.
		const toolBinDir = row(screen.paths, "工具目录");
		check("managed binaries stay in this agent's own home", toolBinDir.includes(".gdou-agent"), toolBinDir);
		check("managed binaries do not land in pi's home", !toolBinDir.includes("\\.pi\\"), toolBinDir);

		// Shipping these is what makes the coding tools work without a network.
		// If provisioning silently does nothing they degrade to a download that
		// may never happen, and the user sees empty results rather than an error.
		const installed = row(screen.binaries, "已就位");
		check("ripgrep is in place", installed.includes("rg"), installed);
		check("fd is in place", installed.includes("fd"), installed);
		check("nothing is missing", row(screen.binaries, "缺失") === "无", row(screen.binaries, "缺失"));
		check("provisioning reported no errors", row(screen.binaries, "错误") === "无", row(screen.binaries, "错误"));

		check("both profiles registered", screen.profileIds.length >= 2, screen.profileIds.join(", "));
		check("general profile present", screen.profileIds.includes("general"), screen.profileIds.join(", "));
		check("coding profile present", screen.profileIds.includes("coding"), screen.profileIds.join(", "));

		const total = Number(row(screen.models, "模型总数"));
		const providers = Number(row(screen.models, "provider 数"));
		check("model catalog is populated", total > 1000, String(total));
		check("provider catalog is populated", providers >= 10, String(providers));
		check("credential report rendered", screen.credentials.includes("DEEPSEEK_API_KEY"), `${screen.credentials.length} chars`);

		// Without keys the diagnostic probe cannot build a session. That is
		// correct behaviour; the point is that the failure is a clean, reported
		// one. (The conversation above ran on the scripted transport, which is
		// why it works without credentials.)
		const agentBuilt = screen.agentClass.includes("ok");
		check("session probe reported a result", agentBuilt || screen.agentClass.includes("bad"), screen.agentClass);

		// ------------------------------------------------------ settings page

		// The page that makes the application usable at all. Without a way to
		// enter a credential, a machine that has no provider environment variables
		// has no reachable model and no way to add one — so "the window opens" is
		// the only thing it can ever do. Everything below exists to keep that from
		// silently regressing.
		process.stdout.write("\nsettings\n");

		await client.evaluate("document.querySelector('[data-view=settings]').click()");
		await waitFor(
			client,
			"document.querySelectorAll('#credential-list .cred-row').length",
			(count) => Number(count) >= 5,
			"the credential rows",
		);

		const pristine = await client.evaluate(`(() => ({
			active: document.querySelector("#primary-nav button.active")?.dataset.view ?? "",
			rows: [...document.querySelectorAll("#credential-list .cred-row")].map((r) => ({
				idle: r.querySelector(".status-pill")?.classList.contains("status-pill--idle") ?? false,
				removeDisabled: r.querySelector("button.ghost")?.disabled ?? null,
			})),
			authPath: document.getElementById("auth-path")?.textContent ?? "",
			note: document.getElementById("model-note")?.textContent ?? "",
		}))()`);

		check("the settings page opens", pristine.active === "settings", pristine.active);
		check("every preset gets a row", pristine.rows.length >= 5, `${pristine.rows.length} row(s)`);
		check("a clean home reports nothing configured", pristine.rows.every((row) => row.idle));
		check("the page names the credential file", pristine.authPath.endsWith("auth.json"), pristine.authPath);
		check("with nothing usable there is no model to pick", pristine.note.includes("没有模型可选"), pristine.note);
		// Removal is offered only for a key we own. A key that arrived through the
		// environment has no file behind it, and an enabled button would promise a
		// deletion that cannot happen.
		check("there is nothing to delete yet", pristine.rows.every((row) => row.removeDisabled === true));

		const FIXTURE_KEY = "sk-gui-check-fixture-0000beef";
		await client.evaluate(`(() => {
			const row = [...document.querySelectorAll("#credential-list .cred-row")]
				.find((r) => r.textContent.includes("DEEPSEEK_API_KEY"));
			row.querySelector(".cred-input").value = ${JSON.stringify(FIXTURE_KEY)};
			row.querySelector("button.outline-button").click();
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('#credential-list .status-pill:not(.status-pill--idle)').length",
			(count) => Number(count) >= 1,
			"the saved key to be reported",
		);

		const configured = await client.evaluate(`(() => ({
			status: [...document.querySelectorAll("#credential-list .cred-row")]
				.find((r) => r.textContent.includes("DEEPSEEK_API_KEY"))
				?.querySelector(".status-pill")?.textContent ?? "",
			body: document.getElementById("view-settings")?.textContent ?? "",
			providers: [...document.getElementById("model-provider").options].map((o) => o.value),
			models: [...document.getElementById("model-id").options].map((o) => o.value),
		}))()`);

		check("the row reports the key as configured", configured.status.includes("已配置"), configured.status);
		// The masked hint is the whole point of the row: "which key is installed"
		// is answerable without the value existing anywhere the renderer can read.
		check("the row shows only a masked hint", configured.status.includes("••••"), configured.status);
		check("the key is never rendered", !configured.body.includes(FIXTURE_KEY));
		check("nor any long fragment of it", !configured.body.includes(FIXTURE_KEY.slice(4, -4)));
		check("the picker now offers the provider", configured.providers.includes("deepseek"), configured.providers.join(","));
		check(
			"and the provider's models",
			configured.models.includes("deepseek/deepseek-flash"),
			configured.models.slice(0, 3).join(","),
		);

		// Written under the throwaway home this check runs in. A store pointed at
		// pi's own directory would land in the real user directory instead, which
		// is precisely the failure this assertion exists to catch.
		const credentialsFile = join(agentHome, "auth.json");
		check("the key reached the credential file", existsSync(credentialsFile), credentialsFile);
		check("and it is the key that was typed", readFileSync(credentialsFile, "utf-8").includes(FIXTURE_KEY));

		// --------------------------------------------------- model switcher

		await client.evaluate("document.querySelector('[data-view=chat]').click()");
		// Asserted before anything is clicked. This is the assertion that would
		// have caught the bug that shipped once: the menu declared `display: flex`
		// without a `[hidden]` override, so the attribute meant nothing, the menu
		// sat on screen from the moment the window opened, and every later
		// attribute check happily reported it as closed.
		check(
			"the model menu starts closed",
			(await client.evaluate(`getComputedStyle(document.getElementById("model-menu")).display`)) === "none",
			await client.evaluate(`getComputedStyle(document.getElementById("model-menu")).display`),
		);
		await client.evaluate("document.getElementById('model-trigger').click()");
		await waitFor(
			client,
			"document.querySelectorAll('#model-menu-list .model-menu-item').length",
			(count) => Number(count) > 0,
			"the model menu to fill",
		);

		const modelMenu = await client.evaluate(`(() => {
			const menu = document.getElementById("model-menu");
			return {
				items: [...document.querySelectorAll("#model-menu-list .model-menu-item")].map((b) => ({
					label: b.textContent.trim(),
					checked: b.getAttribute("aria-checked"),
				})),
				// Computed style, not the hidden property: the attribute states
				// an intent, display is what the reader sees, and the two came
				// apart once already.
				visible: getComputedStyle(menu).display !== "none",
				expanded: document.getElementById("model-trigger").getAttribute("aria-expanded"),
			};
		})()`);

		check("the composer menu opens", modelMenu.visible === true && modelMenu.expanded === "true", String(modelMenu.expanded));
		check("it lists the configured provider's models", modelMenu.items.length > 0, `${modelMenu.items.length} item(s)`);
		// Exactly one, not at least one: a switcher that cannot say which model is
		// running is worse than no switcher, because the menu and the status line
		// would then disagree with nothing to arbitrate between them.
		check(
			"exactly one entry is marked current",
			modelMenu.items.filter((item) => item.checked === "true").length === 1,
			modelMenu.items.map((item) => `${item.label}${item.checked === "true" ? "*" : ""}`).join(" | "),
		);

		// Structure, not only visibility. The menu sits on `body` with `fixed`
		// coordinates because the composer's ancestors set `overflow: hidden` —
		// nested, it was drawn and then clipped away, which reads as a broken menu
		// rather than a covered one. These assertions are what keep it out there.
		const menuBox = await client.evaluate(`(() => {
			const el = document.getElementById("model-menu");
			const rect = el.getBoundingClientRect();
			return {
				onBody: el.parentElement === document.body,
				position: getComputedStyle(el).position,
				insideVertically: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
				insideHorizontally: rect.left >= 0 && rect.right <= window.innerWidth + 1,
			};
		})()`);
		check("the menu is not nested in the composer", menuBox.onBody === true, String(menuBox.onBody));
		check("it is placed against the viewport", menuBox.position === "fixed", menuBox.position);
		check(
			"and lands entirely inside it",
			menuBox.insideVertically && menuBox.insideHorizontally,
			`${menuBox.insideVertically} / ${menuBox.insideHorizontally}`,
		);

		// Choosing one has to actually choose it. The menu lives on `body` now, so
		// the outside-press handler must exempt both the trigger and the menu —
		// otherwise the press closes the menu before the row's own click handler
		// runs, and picking a model silently does nothing at all.
		const chosenSpec = await client.evaluate(`(() => {
			const item = [...document.querySelectorAll("#model-menu-list .model-menu-item")]
				.find((b) => b.getAttribute("aria-checked") !== "true");
			if (!item) return null;
			const spec = item.dataset.spec;
			item.click();
			return spec;
		})()`);
		if (chosenSpec) {
			await waitFor(
				client,
				`document.getElementById("model-label").textContent`,
				(text) => String(text).includes(chosenSpec.split("/")[1]),
				"the running model to change",
			);
			check("choosing a model changes the running one", true, chosenSpec);
			check(
				"the menu closes after choosing",
				(await client.evaluate(`getComputedStyle(document.getElementById("model-menu")).display`)) === "none",
			);
		}

		// Escape is how a popover is dismissed, and a popover that ignores it holds
		// the reader hostage to a control they cannot leave without clicking.
		await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
		check(
			"Escape closes it, visibly",
			(await client.evaluate(`getComputedStyle(document.getElementById("model-menu")).display`)) === "none",
		);

		// --------------------------------------------------- put it back

		// The home is returned to how it was found. The next section asserts what
		// a machine with no credentials does, and a fixture key left behind would
		// quietly turn those assertions into tests of something else.
		await client.evaluate("document.querySelector('[data-view=settings]').click()");
		await waitFor(
			client,
			"document.querySelectorAll('#credential-list .cred-row').length",
			(count) => Number(count) >= 5,
			"the credential rows to come back",
		);
		await client.evaluate(`(() => {
			const row = [...document.querySelectorAll("#credential-list .cred-row")]
				.find((r) => r.textContent.includes("DEEPSEEK_API_KEY"));
			row.querySelector("button.ghost").click();
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('#credential-list .status-pill:not(.status-pill--idle)').length",
			(count) => Number(count) === 0,
			"the key to be removed",
		);
		check(
			"removing the key puts the row back",
			(await client.evaluate(`[...document.querySelectorAll("#credential-list .cred-row")]
				.find((r) => r.textContent.includes("DEEPSEEK_API_KEY")).querySelector("button.ghost").disabled`)) === true,
		);
		check("and the file no longer holds it", !readFileSync(credentialsFile, "utf-8").includes(FIXTURE_KEY));

		await second.stop();
		await sleep(1500);

		// ------------------------------------------------------ preview entry

		// Launched without the scripted transport, which is what a machine with
		// no provider credentials looks like. Without the preview entry point
		// there is no model, so nothing starts and the interface is unreachable
		// — which reads as a broken app rather than an unconfigured one.
		process.stdout.write("\npreview entry\n");
		const third = await launch(agentHome, { GDOU_SCRIPTED_RUN: "0" }, false);
		client = third.client;

		await waitFor(
			client,
			"document.querySelectorAll('.error-block').length",
			(count) => Number(count) >= 1,
			"the failure to be reported",
		);
		const failed = await client.evaluate(`(() => ({
			error: document.querySelector(".error-block")?.textContent ?? "",
			preview: [...document.querySelectorAll(".ghost")].some((b) => b.textContent.includes("预览")),
		}))()`);
		check("a session that cannot start says so", failed.error.length > 0, failed.error.slice(0, 60));
		check("a preview entry point is offered", failed.preview, String(failed.preview));

		// Counted as a delta rather than against an absolute number: earlier
		// sections legitimately create sessions, and an assertion that pins the
		// total would fail for reasons unrelated to what it is checking.
		const sessionsBeforePreview = sessionFiles().length;

		await client.evaluate(
			`[...document.querySelectorAll(".ghost")].find((b) => b.textContent.includes("预览")).click()`,
		);
		const previewStatus = await waitFor(
			client,
			"document.getElementById('status-text')?.textContent ?? ''",
			(value) => typeof value === "string" && value.length > 0 && !value.includes("未启动"),
			"the preview session to start",
		);
		check(
			"the preview is disclosed in the status line",
			String(previewStatus).includes("脚本化运行"),
			String(previewStatus),
		);

		await client.evaluate(`(() => {
			const input = document.getElementById("input");
			input.value = "预览";
			document.getElementById("composer").requestSubmit();
		})()`);
		await waitFor(
			client,
			"document.querySelectorAll('#stream .msg').length",
			(count) => Number(count) >= 4,
			"the preview run to render",
		);
		const previewed = await client.evaluate(READ_TRANSCRIPT);
		check("the preview runs a real turn", previewed.toolCount >= 1, `${previewed.toolCount} tool call(s)`);
		check("the preview renders the user message", previewed.userText.includes("预览"), previewed.userText);

		// A preview is a demonstration, not a conversation. Persisting it would
		// put a transcript the user never had next to their real work, where it
		// would be indistinguishable from it.
		check(
			"the preview is not written to history",
			sessionFiles().length === sessionsBeforePreview,
			`${sessionsBeforePreview} before, ${sessionFiles().length} after`,
		);
		const listedAfterPreview = await client.evaluate(
			"window.gdou.listSessions('general').then((s) => s.length)",
		);
		check("the preview does not appear in the list", Number(listedAfterPreview) === 1, String(listedAfterPreview));

		client.close();
		await third.stop();

		// Printed last, so the count covers every phase.
		process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
		if (!agentBuilt) {
			process.stdout.write(`session probe: ${screen.agent}\n`);
			process.stdout.write("(no API key set; the diagnostic probe is expected to report that)\n");
		}
		process.stdout.write(`project root: ${projectRoot}\n`);
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}

	process.exit(failures === 0 ? 0 : 1);
}

await main().catch((error) => {
	process.stdout.write(`\nFAIL ${error.message}\n`);
	const log = lastAppOutput.join("").trim();
	if (log) process.stdout.write(`--- application output ---\n${log}\n`);
	process.exit(1);
});
