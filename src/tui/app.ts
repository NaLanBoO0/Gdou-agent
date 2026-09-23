/**
 * TUI application.
 *
 * Renders an `AgentSession` as a scrolling transcript with a persistent input
 * line. The decisions that are not obvious from the code:
 *
 * - Main screen, not alt screen. The transcript lands in the terminal's own
 *   scrollback, so native scroll, search, and copy keep working. An alt-screen
 *   TUI trades all three away for a fixed viewport, which is the wrong trade
 *   for an assistant whose output people copy out of.
 *
 * - `setClearOnShrink` stays off. Enabling it makes any shrink trigger a full
 *   redraw, and `TuiMainScreen`'s full redraw clears the scrollback - so
 *   collapsing a tool call would erase the history the main screen exists to
 *   preserve. The differential renderer already clears the rows a shrink
 *   vacated, so nothing is left behind.
 *
 * - One subscription, one routing switch. Every view is driven by the
 *   normalized `AgentEvent` vocabulary, so pi's own event shape never reaches
 *   presentation code.
 *
 * - Tool output is collapsed by default. A single `read` of a large file or a
 *   `bash` call can emit hundreds of lines; shown inline, they bury the answer.
 */

import type { Terminal, TuiInputListenerResult } from "@earendil-works/pi-tui";
import { Editor, matchesKey, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { AgentSession } from "../kernel/agent.ts";
import type { AgentEvent } from "../kernel/events.ts";
import { toolResultText } from "../kernel/events.ts";
import { AssistantMessageView, UserMessageView } from "./components/messages.ts";
import { NoticeView, StaticView } from "./components/notice.ts";
import { StatusLine } from "./components/status-line.ts";
import { ToolCallView } from "./components/tool-call.ts";
import { Transcript } from "./components/transcript.ts";
import { createTheme, type TuiTheme } from "./theme.ts";

export interface TuiAppOptions {
	session: AgentSession;
	theme?: TuiTheme;
	/**
	 * Terminal to render into. Defaults to the process's stdio. Supplying one
	 * lets the app run over a remote terminal, or a recording one in a test.
	 */
	terminal?: Terminal;
}

export class TuiApp {
	private readonly session: AgentSession;
	private readonly theme: TuiTheme;
	private readonly terminal: Terminal;
	private readonly tui: TuiMainScreen;
	private readonly transcript: Transcript;
	private readonly editor: Editor;
	private readonly status: StatusLine;

	/** Tool views by call id, for routing updates and completions. */
	private readonly toolViews = new Map<string, ToolCallView>();

	/** The assistant message currently being streamed, if any. */
	private currentAssistant: AssistantMessageView | undefined;

	private unsubscribe: (() => void) | undefined;
	private removeInputListener: (() => void) | undefined;
	private removeExitHandler: (() => void) | undefined;

	/** A run is in flight. Set synchronously on submit to close the re-entry gap. */
	private running = false;
	/** The user pressed ctrl+c once while idle; a second press exits. */
	private confirmExit = false;
	private stopped = false;
	private onExit: (() => void) | undefined;

	constructor(options: TuiAppOptions) {
		this.session = options.session;
		this.theme = options.theme ?? createTheme();
		this.terminal = options.terminal ?? new ProcessTerminal();
		// Hardware cursor on: the editor emits a cursor marker, and without this
		// the terminal hides the caret, breaking IME candidate placement.
		this.tui = new TuiMainScreen(this.terminal, true);
		this.transcript = new Transcript(this.theme);
		this.editor = new Editor(this.tui, this.theme.editor, { paddingX: 0 });
		this.status = new StatusLine(this.tui, this.theme);
	}

	// -------------------------------------------------------------- lifecycle

	/**
	 * Start the UI and resolve when the user exits.
	 *
	 * Never rejects: a failure inside a run is reported in the transcript, since
	 * there is nothing above this to hand it to and tearing the terminal down on
	 * a provider error would be hostile.
	 */
	async run(options: { banner?: boolean } = {}): Promise<void> {
		this.install(options.banner ?? true);
		await new Promise<void>((resolve) => {
			this.onExit = resolve;
		});
	}

	/** Stop the UI and restore the terminal. Safe to call more than once. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;

		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		this.removeExitHandler?.();
		this.removeExitHandler = undefined;

		this.toolViews.clear();
		this.transcript.dispose();
		this.status.dispose();
		this.tui.stop();

		this.onExit?.();
		this.onExit = undefined;
	}

	// -------------------------------------------------------------- internals

	private install(banner: boolean): void {
		this.tui.addChild(this.transcript);
		this.tui.addChild(new StaticView([""]));
		this.tui.addChild(this.editor);
		this.tui.addChild(this.status);

		this.status.setProfile(this.session.profile.label);
		this.status.setExpert(this.session.expert?.label ?? "");
		this.status.setModel(`${this.session.model.provider}/${this.session.model.id}`);
		this.status.setFallback(
			this.session.fallback ? `${this.session.fallback.provider}/${this.session.fallback.id}` : "",
		);
		this.status.setCwd(this.session.cwd);

		if (banner) this.pushBanner();

		this.editor.onSubmit = (text) => {
			const trimmed = text.trim();
			if (trimmed.length === 0 || this.running) return;
			void this.submit(trimmed);
		};

		this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
		this.removeInputListener = this.tui.addInputListener((data) => this.handleKey(data));

		// The terminal is in raw mode, so SIGINT is not delivered; this covers the
		// case where the process is signalled from outside or exits on its own.
		const onProcessExit = (): void => this.stop();
		process.once("exit", onProcessExit);
		this.removeExitHandler = () => process.removeListener("exit", onProcessExit);

		this.terminal.setTitle("GDOU agent");
		this.tui.start();
		this.tui.setFocus(this.editor);
	}

	private pushBanner(): void {
		const lines = [
			this.theme.bold("GDOU agent") + this.theme.dim("  built on the pi kernel"),
			"",
			this.theme.dim(
				"ctrl+o last tool · ctrl+t all tools · ctrl+l clear · ctrl+c exit · enter send · shift+enter newline",
			),
			"",
		];
		this.transcript.push({ kind: "static", view: new StaticView(lines) });
	}

	private async submit(text: string): Promise<void> {
		this.running = true;
		this.editor.disableSubmit = true;
		this.status.setWorking(true);

		this.transcript.push({ kind: "user", view: new UserMessageView(this.theme, text) });
		this.tui.requestRender();

		try {
			await this.session.prompt(text);
		} catch (error) {
			this.pushNotice(error instanceof Error ? error.message : String(error), "error");
		} finally {
			// The run_end event normally clears these, but a throw before the run
			// started never produces one, and the editor must not stay locked.
			this.running = false;
			this.editor.disableSubmit = false;
			this.status.setWorking(false);
			this.tui.requestRender();
		}
	}

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "run_start":
				this.running = true;
				this.editor.disableSubmit = true;
				this.status.setWorking(true);
				break;

			case "assistant_start": {
				const view = new AssistantMessageView(this.theme);
				this.currentAssistant = view;
				this.transcript.push({ kind: "assistant", view });
				break;
			}

			case "text_delta":
				this.currentAssistant?.appendText(event.text);
				break;

			case "thinking_delta":
				this.currentAssistant?.appendThinking(event.text);
				break;

			case "assistant_end":
				this.currentAssistant?.finish();
				this.currentAssistant = undefined;
				break;

			case "tool_start": {
				const view = new ToolCallView(this.tui, this.theme, { name: event.name, args: event.args });
				this.toolViews.set(event.id, view);
				this.transcript.push({ kind: "tool", view });
				break;
			}

			case "tool_update":
				this.toolViews.get(event.id)?.setOutput(toolResultText(event.partial));
				break;

			case "tool_end": {
				const view = this.toolViews.get(event.id);
				if (view) {
					view.finish(event.result, event.isError);
					this.toolViews.delete(event.id);
				}
				break;
			}

			case "error":
				this.pushNotice(event.message, "error");
				break;

			case "run_end":
				this.running = false;
				this.editor.disableSubmit = false;
				this.status.setWorking(false);
				break;

			case "turn_end":
				break;
		}

		this.tui.requestRender();
	}

	private pushNotice(text: string, tone: "error" | "warning" | "dim"): void {
		this.transcript.push({ kind: "notice", view: new NoticeView(this.theme, text, { tone }) });
		this.tui.requestRender();
	}

	/**
	 * Global key handling, which runs before the focused editor sees the key.
	 *
	 * Returning `{ consume: true }` keeps the key away from the editor; returning
	 * undefined lets it through unchanged.
	 */
	private handleKey(data: string): TuiInputListenerResult {
		// Any key other than ctrl+c cancels a pending exit confirmation.
		if (!matchesKey(data, "ctrl+c")) this.confirmExit = false;

		if (matchesKey(data, "ctrl+c")) {
			if (this.running) {
				this.session.abort();
				this.status.setHint("aborting");
				return { consume: true };
			}
			if (!this.confirmExit) {
				this.confirmExit = true;
				this.status.setHint("press ctrl+c again to exit");
				return { consume: true };
			}
			this.stop();
			return { consume: true };
		}

		// ctrl+d exits on an empty input, matching the shell convention. With text
		// present it is left to the editor, where it deletes forward.
		if (matchesKey(data, "ctrl+d") && this.editor.getText().length === 0) {
			this.stop();
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+o")) {
			const tool = this.transcript.lastTool;
			if (!tool) {
				this.status.setHint("no tool call to expand");
				return { consume: true };
			}
			const expanded = tool.toggleExpanded();
			this.status.setHint(`${expanded ? "expanded" : "collapsed"} ${tool.toolName}`);
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+t")) {
			const total = this.transcript.toolCount;
			if (total === 0) {
				this.status.setHint("no tool calls to expand");
				return { consume: true };
			}
			const expand = this.transcript.expandedToolCount === 0;
			this.transcript.setAllToolsExpanded(expand);
			this.status.setHint(`${expand ? "expanded" : "collapsed"} ${total} tool call${total === 1 ? "" : "s"}`);
			return { consume: true };
		}

		if (matchesKey(data, "ctrl+l")) {
			this.transcript.clear();
			this.status.setHint("transcript cleared");
			return { consume: true };
		}

		return undefined;
	}
}
