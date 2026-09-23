#!/usr/bin/env node
/**
 * TUI verification.
 *
 * The TUI normally needs a terminal, which makes it awkward to test and easy to
 * get subtly wrong. This script supplies a `Terminal` that records writes
 * instead of touching stdio, drives real agent turns through a scripted
 * provider, and asserts on what reached the terminal.
 *
 * That covers what a component-level test cannot: event routing from pi through
 * the normalization layer into the view layer, the live tool-output path, and
 * the collapse keybinding. It also proves nothing renders wider than the
 * terminal, because `TuiMainScreen` throws when a line does - so a run that
 * finishes is itself the assertion for that.
 *
 * Two things about the harness are worth knowing before reading it:
 *
 * - Input is delivered one code unit at a time. `ProcessTerminal` splits a
 *   batch of bytes into individual key events with `StdinBuffer`; a fake that
 *   hands over `"hello\r"` as one string is not simulating a terminal, it is
 *   simulating a paste, and the editor will treat the carriage return as text.
 *
 * - `stripTerminalSequences` is not used to read the output. Its CSI branch
 *   terminates only on `[mGKHJ]`, so the synchronized-output markers
 *   (`ESC[?2026h`) it would have to handle here are mis-parsed and swallow the
 *   text that follows. This script strips with the full ECMA-48 final-byte
 *   range instead.
 *
 * Runs offline and costs nothing.
 *
 * Run: npm run check:tui
 */

import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { Editor, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { createAgent, type AgentSession } from "../src/kernel/agent.ts";
import type { AgentEvent } from "../src/kernel/events.ts";
import { registerProfile } from "../src/profiles/registry.ts";
import { TuiApp } from "../src/tui/app.ts";
import { NoticeView } from "../src/tui/components/notice.ts";
import { ProfilePicker, type ProfileChoice } from "../src/tui/components/profile-picker.ts";
import { Transcript } from "../src/tui/components/transcript.ts";
import { createTheme } from "../src/tui/theme.ts";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
	const mark = condition ? "ok  " : "FAIL";
	if (!condition) failures++;
	console.log(`  [${mark}] ${label}${detail ? `  ${detail}` : ""}`);
}

// --------------------------------------------------------------- ansi stripping

/** CSI (final byte 0x40-0x7E), OSC, and APC sequences. */
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|_[^\u0007\u001b]*(?:\u0007|\u001b\\))/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------- fake terminal

/**
 * A `Terminal` that keeps everything written to it and splits input into key
 * events, the way a real terminal plus `StdinBuffer` would.
 */
class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	columnsValue = 80;
	rowsValue = 24;

	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.columnsValue;
	}

	get rows(): number {
		return this.rowsValue;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	/** Everything written so far, with control sequences removed. */
	get plain(): string {
		return stripAnsi(this.writes.join(""));
	}

	/** Deliver input one key event at a time, as a terminal would. */
	send(data: string): void {
		for (const char of data) this.inputHandler?.(char);
	}

	/** Report a terminal resize. */
	resize(width: number, height: number): void {
		this.columnsValue = width;
		this.rowsValue = height;
		this.resizeHandler?.();
	}

	/** Forget what has been written, so the next render can be read alone. */
	reset(): void {
		this.writes.length = 0;
	}
}

// ---------------------------------------------------------------- probe profile

const streamingSchema = Type.Object({ count: Type.Number() });

/**
 * A tool that reports progress before returning.
 *
 * The built-in tools only stream output for shell commands, so a probe is the
 * cheapest way to exercise the `tool_update` path deterministically.
 *
 * Two details matter for the test to mean anything. The updates are spaced out
 * in time: emitting them all in one tick would be coalesced into a single frame
 * by the renderer's throttle, which is correct behaviour but proves nothing
 * about live output. And the final result repeats the streamed text, matching
 * the convention the built-in shell tool follows - the final result is
 * authoritative, so a probe whose result were merely a summary would have its
 * streamed output replaced on completion.
 */
const streamingTool: AgentTool<typeof streamingSchema, { lines: number }> = {
	name: "stream_lines",
	label: "Stream lines",
	description: "Emit numbered lines, reporting each one as it is produced.",
	parameters: streamingSchema,
	async execute(_toolCallId, params, _signal, onUpdate) {
		const count = Math.max(1, Math.min(50, params.count));
		const produced: string[] = [];
		for (let i = 1; i <= count; i++) {
			produced.push(`line ${i}`);
			onUpdate?.({ content: [{ type: "text", text: produced.join("\n") }], details: { lines: i } });
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return { content: [{ type: "text", text: produced.join("\n") }], details: { lines: count } };
	},
};

registerProfile({
	id: "tui-probe",
	label: "TUI probe",
	description: "Profile used by the TUI verification script.",
	systemPrompt: () => "You are a verification probe.",
	tools: () => [streamingTool],
});

// --------------------------------------------------------------------- helpers

/** Wait until `predicate` holds, or give up after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

/** Build a session driven by a scripted provider. */
/**
 * Build the probe session.
 *
 * The expert is `researcher` on purpose: it declares no tool list, so it adds a
 * status-line segment without narrowing the tool set this file also asserts on.
 * A narrowing expert here would make those assertions test the wrong thing.
 */
async function makeSession(
	responses: ReturnType<typeof fauxAssistantMessage>[],
	expert = "researcher",
): Promise<AgentSession> {
	const faux = fauxProvider();
	faux.setResponses(responses);

	const models = createModels();
	models.setProvider(faux.provider);
	const fauxModel = faux.getModel();
	const streamFn: StreamFn = (_model, context, options) => models.streamSimple(fauxModel, context, options);

	return createAgent({
		recipe: { mode: "tui-probe", expert },
		// Resolved for its metadata only; the scripted transport ignores it.
		model: "deepseek/deepseek-flash",
		streamFn,
		settings: {},
	});
}

// --------------------------------------------------------------------- checks

async function checkComponents(): Promise<void> {
	const theme = createTheme("dark", false);

	console.log("Profile picker");
	const choices: ProfileChoice[] = [
		{ id: "general", label: "Daily tasks", description: "Notes and time." },
		{ id: "coding", label: "Coding tasks", description: "Read, edit, run." },
	];
	let selected: string | undefined;
	let cancelled = false;
	const picker = new ProfilePicker({
		theme,
		profiles: choices,
		onSelect: (id) => {
			selected = id;
		},
		onCancel: () => {
			cancelled = true;
		},
	});

	const pickerLines = picker.render(80);
	check("picker lists every profile", choices.every((c) => pickerLines.join("\n").includes(c.label)));
	check("picker shows descriptions", pickerLines.join("\n").includes("Read, edit, run."));
	check("picker shows key hints", pickerLines.join("\n").includes("esc cancel"));
	check("picker lines fit the width", pickerLines.every((line) => stripAnsi(line).length <= 80));

	picker.selectIndex(1);
	picker.handleInput("\r");
	check("enter selects the highlighted profile", selected === "coding", selected);

	picker.handleInput("\u001b");
	check("escape cancels", cancelled);

	console.log("\nTranscript bounds");
	const transcript = new Transcript(theme);
	for (let i = 0; i < 205; i++) {
		transcript.push({ kind: "notice", view: new NoticeView(theme, `entry ${i}`) });
	}
	const transcriptLines = transcript.render(80).join("\n");
	check("oldest entries are dropped", !transcriptLines.includes("entry 0\n"), "cap enforced");
	check("dropping is reported", transcriptLines.includes("earlier entries elided"));
	check("newest entries survive", transcriptLines.includes("entry 204"));

	console.log("\nNarrow terminal");
	const narrow = new Transcript(theme);
	narrow.push({ kind: "notice", view: new NoticeView(theme, "x".repeat(400)) });
	const narrowLines = narrow.render(20);
	check(
		"long text wraps instead of overflowing",
		narrowLines.every((line) => stripAnsi(line).length <= 20),
		`${narrowLines.length} lines at width 20`,
	);

	console.log("\nEditor key handling");
	const editorTerminal = new RecordingTerminal();
	const editorTui = new TuiMainScreen(editorTerminal, true);
	const editor = new Editor(editorTui, theme.editor, { paddingX: 0 });
	let submitted: string | undefined;
	editor.onSubmit = (text) => {
		submitted = text;
	};
	editorTui.addChild(editor);
	editorTui.setFocus(editor);
	editorTui.start();

	editorTerminal.send("hello world\r");
	check("enter submits", submitted === "hello world", JSON.stringify(submitted));
	check("editor clears after submit", editor.getText() === "");

	editorTerminal.send("draft");
	editor.disableSubmit = true;
	editorTerminal.send("\r");
	check("disableSubmit blocks re-entry", editor.getText() === "draft");
	editor.disableSubmit = false;
	editorTui.stop();
}

async function checkApp(): Promise<void> {
	const theme = createTheme("dark", false);

	// Two turns: the first calls the streaming tool, the second answers.
	const session = await makeSession([
		fauxAssistantMessage([fauxToolCall("stream_lines", { count: 12 })], { stopReason: "toolUse" }),
		fauxAssistantMessage("# Done\n\nThe probe finished.\n\n```ts\nconst x = 1;\n```\n"),
	]);

	const terminal = new RecordingTerminal();
	const app = new TuiApp({ session, theme, terminal });

	const events: AgentEvent[] = [];
	session.subscribe((event) => events.push(event));

	const running = app.run({ banner: true });
	await waitFor(() => terminal.plain.includes("Gdouwork"));

	console.log("\nStartup");
	const startup = terminal.plain;
	check("banner is rendered", startup.includes("built on the pi kernel"));
	check("banner lists keybindings", startup.includes("ctrl+o last tool"));
	check("status line shows the profile", startup.includes("TUI probe"));
	check("status line shows the expert", startup.includes("调研"), startup.split("\n").at(-2) ?? "");
	check("status line shows the model", startup.includes("deepseek/deepseek-flash"));
	// Lowercase distinguishes the working directory from the uppercase banner.
	check("status line shows the working directory", startup.includes("gdou-agent"));
	check("input box is drawn", startup.includes("───"));

	// Type a message and press enter.
	terminal.send("run the probe\r");
	const finished = await waitFor(() => events.some((e) => e.type === "run_end"));
	check("the run completed", finished);
	// Rendering is throttled, so the frame carrying the last message lands
	// slightly after the run ends.
	await waitFor(() => terminal.plain.includes("The probe finished."));

	const afterRun = terminal.plain;
	console.log("\nConversation");
	check("user message is echoed with a marker", afterRun.includes("› run the probe"));
	check("assistant markdown is rendered", afterRun.includes("The probe finished."));
	check("assistant heading is rendered", afterRun.includes("Done"));
	check("code block content is rendered", afterRun.includes("const x = 1;"));

console.log("\nLive tool output");
check("tool header is rendered", afterRun.includes("stream_lines"));
check("tool argument is shown", afterRun.includes("stream_lines 12"), "primary argument");
check("streamed output reached the terminal", afterRun.includes("│ line 12"));
check("a spinner was drawn while the run was in flight", /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(afterRun));
const firstPartial = afterRun.indexOf("│ line 2");
const lastPartial = afterRun.indexOf("│ line 12");
check(
	"output was rendered incrementally, not in one dump",
	firstPartial !== -1 && lastPartial !== -1 && firstPartial < lastPartial,
	`line 2 at ${firstPartial}, line 12 at ${lastPartial}`,
);

	console.log("\nCollapsed state");
	// Only the footer is asserted here. The accumulated log contains the frames
	// drawn while the tool was still streaming, where fewer lines existed and so
	// nothing was hidden yet; the single-frame assertions live in the
	// keybinding section below, where the log is reset first.
	check("collapsed view reports the hidden count", afterRun.includes("6 more · 12 lines total"));
	check("collapsed view advertises expansion", afterRun.includes("ctrl+o to expand"));

	console.log("\nCollapse keybinding");
	terminal.reset();
	terminal.send("\u000f"); // ctrl+o
	await waitFor(() => terminal.plain.includes("ctrl+o to collapse"));
	const expanded = terminal.plain;
	check("ctrl+o expands the tool call", expanded.includes("ctrl+o to collapse"));
	check("expanded view reveals the head of the output", expanded.includes("│ line 6"));
	check("expanded view reports the total", expanded.includes("12 lines · ctrl+o to collapse"));
	check("status line reports the action", expanded.includes("expanded stream_lines"));

	terminal.reset();
	terminal.send("\u000f"); // ctrl+o again
	await waitFor(() => terminal.plain.includes("ctrl+o to expand"));
	const recollapsed = terminal.plain;
	check("ctrl+o collapses again", recollapsed.includes("ctrl+o to expand"));
	check("collapsed view keeps the tail", recollapsed.includes("│ line 12"));
	check("collapsed view drops the head", !recollapsed.includes("│ line 6"));

	console.log("\nTool toggling");
	terminal.reset();
	terminal.send("\u0014"); // ctrl+t
	await waitFor(() => terminal.plain.includes("ctrl+o to collapse"));
	check("ctrl+t expands every tool call", terminal.plain.includes("ctrl+o to collapse"));

	console.log("\nResize");
	let resizeFailed = false;
	try {
		terminal.resize(40, 20);
		await waitFor(() => true, 200);
	} catch (error) {
		resizeFailed = true;
		console.log(`  (threw: ${error instanceof Error ? error.message : String(error)})`);
	}
	check("re-rendering at width 40 does not throw", !resizeFailed);

	console.log("\nClear and exit");
	terminal.reset();
	terminal.send("\u000c"); // ctrl+l
	await waitFor(() => terminal.plain.includes("transcript cleared"));
	check("ctrl+l reports clearing", terminal.plain.includes("transcript cleared"));

	terminal.reset();
	terminal.send("\u0003"); // ctrl+c
	await waitFor(() => terminal.plain.includes("press ctrl+c again to exit"));
	check("first ctrl+c asks for confirmation", terminal.plain.includes("press ctrl+c again to exit"));

	terminal.reset();
	terminal.send("\u0003"); // ctrl+c again
	check("second ctrl+c exits the app", await Promise.race([running.then(() => true), waitFor(() => false, 500)]));

	session.dispose();
}

async function main(): Promise<void> {
	await checkComponents();
	await checkApp();

	console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.error(`\nTUI check crashed: ${error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
