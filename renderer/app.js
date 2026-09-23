/**
 * Renderer.
 *
 * A conversation interface over the normalized event stream. It renders one
 * event at a time and never asks the kernel anything except through
 * `window.gdou`, which preload.ts exposes.
 *
 * Kept build-free on purpose: it is a single classic script with no imports, so
 * it loads from `file://` without a bundler. (ES module imports do not work
 * over `file://` — Chromium blocks them — which is why this is not split into
 * modules.)
 *
 * The shell — titlebar, sidebar, inspector — is the desktop workbench, because
 * the two apps are meant to read as one product. The DOM contract is not: `check:gui`
 * drives this window from outside and asserts on specific ids and classes, so
 * names like `.msg-user .body`, `.tool-name`, `.menu-row` and `#cwd` are
 * load-bearing. Renaming one silently turns an assertion into a no-op, which is
 * worse than a failing one. Where a different name would read better, the old
 * one is kept and the reason noted.
 *
 * Assistant text is shown as plain text while it streams and re-rendered as
 * markdown once the message ends. Rendering markdown incrementally would mean
 * re-parsing a half-written code fence on every delta, for no visible gain.
 */

const byId = (id) => document.getElementById(id);

/** An inline icon, sized and stroked like the rest of the shell. */
function icon(paths, size = 15) {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.75");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	for (const d of paths) {
		const path = document.createElementNS(ns, "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	return svg;
}

// ------------------------------------------------------------------ helpers

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function escapeHtml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render assistant text as full markdown, via `marked` (vendored into
 * `renderer/marked.umd.js`).
 *
 * The previous hand-rolled renderer handled only code blocks, inline code, and
 * bold — so a reply with headings, lists, tables, or blockquotes came out as an
 * undifferentiated wall of text. `marked` is the same engine the shell uses, so
 * switching to it is not a styling change but a replacement of the parser
 * itself. `breaks: true` keeps single newlines as line breaks, matching how the
 * model's raw output reads.
 */
function renderMarkdown(text) {
	if (typeof marked === "undefined") {
		// The script tag failed to load (missing vendored file). Fall back to
		// escaped plain text rather than crashing the whole render.
		return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
	}
	return marked.parse(text, { async: false, breaks: true });
}

/** A short, legible summary of a tool call's arguments. */
function describeArgs(args) {
	if (typeof args !== "object" || args === null) return "";
	const record = args;
	for (const key of ["path", "file_path", "command", "pattern", "query", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	for (const value of Object.values(record)) {
		if (typeof value === "string" && value.length > 0) return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return "";
}

/** Pull display text out of a tool result payload. */
function resultText(result) {
	if (typeof result === "string") return result;
	if (typeof result !== "object" || result === null) return "";
	const content = result.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			if (block.type === "text") return typeof block.text === "string" ? block.text : "";
			if (block.type === "image") return "[image]";
			return "";
		})
		.join("\n");
}

// -------------------------------------------------------------------- state

const state = {
	profileId: null,
	/** Expert id, or null for none. Part of the recipe, so it forces a rebuild. */
	expertId: null,
	session: null,
	running: false,
	/** The assistant body currently receiving deltas. */
	assistant: null,
	/** The thinking panel currently receiving deltas, so they accumulate. */
	thinking: null,
	/** Live tool blocks, keyed by tool call id. */
	tools: new Map(),
	/** Latest split between the transcript and what the model is shown. */
	context: null,
	/** Which page the main column is showing. */
	view: "chat",
	/** Sessions for the current mode, kept so the sidebar and menu agree. */
	sessions: [],
	/**
	 * Artifacts delivered this session, in order.
	 *
	 * Accumulated rather than derived from the transcript because the inspector
	 * has to list them without re-reading every tool result, and because a
	 * resumed conversation shows the cards from the restored messages anyway.
	 */
	artifacts: [],
	/** The last experts catalog, for the paths card on the experts page. */
	expertCatalog: null,
	/** The last skills catalog, for the paths card on the skills page. */
	skillCatalog: null,
	/**
	 * Last credential rows read from the main process.
	 *
	 * Cached so a redraw does not re-ask, and so the model picker can know which
	 * providers are usable without a second round trip. Never holds a key — the
	 * rows carry a masked hint at most.
	 */
	credentials: [],
	inspectorVisible: true,
	/** Number of user turns rendered, so each turn gets a stable ordinal. */
	turnCount: 0,
};

// --------------------------------------------------------------- transcript

const stream = byId("stream");
/** Messages live here; `#empty` is its first child and is never removed. */
const transcriptEl = document.querySelector(".transcript");

/** Keep the newest content visible unless the reader has scrolled up. */
function autoScroll() {
	const distanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
	if (distanceFromBottom < 120) stream.scrollTop = stream.scrollHeight;
}

/**
 * Scroll to the bottom unconditionally.
 *
 * `autoScroll` refuses to move once the reader has scrolled up, which is right
 * during a live run — the reader's position is a signal. But a *restored*
 * session is a different event: the reader has not chosen a position yet, so the
 * honest place to land is the newest message, not the top. That is why restoring
 * uses this rather than `autoScroll`.
 */
function scrollToBottom() {
	stream.scrollTop = stream.scrollHeight;
}

/**
 * Show or hide the empty state.
 *
 * Hidden rather than removed: it holds the hint text, and once removed there is
 * nothing left to write into or to bring back — which is exactly how starting a
 * new conversation used to fail.
 */
function setEmptyVisible(visible) {
	const empty = byId("empty");
	if (empty) empty.hidden = !visible;
}

function append(node) {
	setEmptyVisible(false);
	transcriptEl.append(node);
	autoScroll();
	return node;
}

/**
 * Fold a run of consecutive tool calls into one card.
 *
 * Two decisions worth stating, because both are about not making things worse:
 *
 * **Only from the second call.** A group of one is a tool row with a redundant
 * header, and leaving single calls untouched means the common case — one tool
 * per turn — renders exactly as it always did. That also keeps the existing
 * DOM contract honest: the first `.tool` a check clicks is never inside a
 * collapsed group unless there really were several calls.
 *
 * **Built retroactively.** The first call is appended normally; the group is
 * created when a second one arrives to join it. There is no way to know a run
 * is starting until the second call appears, and predicting would mean either
 * buffering the first one or restructuring it after the fact.
 */
function appendToolNode(node) {
	const last = transcriptEl.lastElementChild;

	// A tool call always lands inside a group. The group is the "what is the
	// agent using right now" summary — a running one folds by default and shows
	// "正在使用 N 个工具" — so even the first call of a turn gets a group rather
	// than sitting as a lone open card.
	if (last && last.classList.contains("tool-group")) {
		last.querySelector(".tool-group-body").append(node);
		refreshToolGroup(last);
		return;
	}

	// A lone tool call sitting where a group would start.
	if (last && last.classList.contains("msg") && last.querySelector(":scope > .tool")) {
		const group = createToolGroup();
		transcriptEl.replaceChild(group, last);
		const body = group.querySelector(".tool-group-body");
		body.append(last, node);
		refreshToolGroup(group);
		return;
	}

	// First tool of a turn: start a fresh group around it.
	const group = createToolGroup();
	group.querySelector(".tool-group-body").append(node);
	transcriptEl.append(group);
	refreshToolGroup(group);
}

function createToolGroup() {
	const group = element("div", "tool-group running");
	const head = element("button", "tool-group-head");
	head.type = "button";

	const caret = element("span", "tool-group-caret", "▸");
	// The three dots signal "still working" without needing the group open — a
	// running group folds by default, and the dots are the only hint that work
	// is ongoing underneath.
	const dots = element("span", "tool-group-dots");
	const label = element("span", "tool-group-label");
	const count = element("span", "tool-group-count");
	head.append(caret, dots, label, count);
	head.addEventListener("click", () => {
		const open = group.classList.toggle("open");
		caret.textContent = open ? "▾" : "▸";
	});

	const body = element("div", "tool-group-body");
	group.append(head, body);
	return group;
}

/**
 * Update a group's header from the calls inside it.
 *
 * The label names the tools rather than counting them: "read · edit · read"
 * tells the user what happened, and "3 个工具" only tells them how many rows
 * they are not looking at.
 */
function refreshToolGroup(group) {
	const names = [...group.querySelectorAll(".tool-name")].map((el) => el.textContent);
	const unique = [...new Set(names)];
	const label = group.querySelector(".tool-group-label");
	const count = group.querySelector(".tool-group-count");
	label.textContent = unique.slice(0, 4).join(" · ") + (unique.length > 4 ? " …" : "");
	// While running, "N 个工具" reads as "what is in flight"; once finished, the
	// dots leave and the count reads as a plain summary.
	count.textContent = group.classList.contains("running") ? `正在使用 ${names.length} 个工具` : `${names.length} 次调用`;
}

/** Collapse finished groups; a group that is still running stays open. */
function collapseFinishedToolGroups() {
	for (const group of transcriptEl.querySelectorAll(".tool-group.open")) {
		group.classList.remove("open");
		const caret = group.querySelector(".tool-group-caret");
		if (caret) caret.textContent = "▸";
	}
	// A finished group is no longer "in flight": drop the running state so the
	// header stops saying "正在使用" and the dots stop bouncing.
	for (const group of transcriptEl.querySelectorAll(".tool-group.running")) {
		group.classList.remove("running");
		refreshToolGroup(group);
	}
}

function clearTranscript() {
	for (const node of [...transcriptEl.children]) {
		if (node.id !== "empty") node.remove();
	}
	state.assistant = null;
	state.thinking = null;
	state.tools.clear();
	state.turnCount = 0;
	setEmptyVisible(true);
	syncTurnDots();
}

/* ---------------------------------------------------------- turn dots */

/**
 * Rebuild the turn-dot rail from the user messages in the transcript.
 *
 * One dot per `.msg-user`, in order. A single turn is not enough to navigate, so
 * the rail stays hidden until there are two — which is also when "where am I"
 * first becomes a question worth answering.
 */
function syncTurnDots() {
	const wrap = byId("turn-dots");
	const scroll = byId("turn-dot-scroll");
	const turns = transcriptEl.querySelectorAll(".msg-user");

	if (turns.length < 2) {
		wrap.hidden = true;
		scroll.replaceChildren();
		return;
	}
	wrap.hidden = false;

	const dots = [...turns].map((msg) => {
		const dot = element("button", "turn-dot");
		dot.type = "button";
		dot.dataset.turn = msg.dataset.turn;
		dot.setAttribute("role", "tab");
		dot.setAttribute("aria-label", `第 ${msg.dataset.turn} 轮`);
		dot.addEventListener("click", () => msg.scrollIntoView({ behavior: "smooth", block: "start" }));
		dot.addEventListener("mouseenter", (event) => showTurnBubble(msg, dot, event));
		dot.addEventListener("mouseleave", hideTurnBubble);
		return dot;
	});

	scroll.replaceChildren(...dots);
	updateTurnActive();
}

/**
 * The dot that is "current" is the user message closest to the top of the
 * viewport — the turn the reader is reading right now, not the newest.
 */
function updateTurnActive() {
	const wrap = byId("turn-dots");
	if (wrap.hidden) return;
	const turns = transcriptEl.querySelectorAll(".msg-user");
	if (!turns.length) return;

	const top = stream.getBoundingClientRect().top + 8;
	let current = turns[0];
	let best = Infinity;
	for (const msg of turns) {
		const distance = Math.abs(msg.getBoundingClientRect().top - top);
		if (distance < best) {
			best = distance;
			current = msg;
		}
	}

	for (const dot of byId("turn-dot-scroll").querySelectorAll(".turn-dot")) {
		dot.classList.toggle("active", dot.dataset.turn === current.dataset.turn);
	}
}

function showTurnBubble(msg, dot, event) {
	const bubble = byId("turn-dot-bubble");
	bubble.textContent = msg.querySelector(".body")?.textContent?.slice(0, 40) ?? `第 ${msg.dataset.turn} 轮`;
	bubble.hidden = false;
	const rect = dot.getBoundingClientRect();
	bubble.style.top = `${rect.top + rect.height / 2}px`;
	bubble.style.left = `${rect.left}px`;
}

function hideTurnBubble() {
	byId("turn-dot-bubble").hidden = true;
}

function addUserMessage(text) {
	const wrapper = element("div", "msg msg-user");
	wrapper.dataset.turn = String(++state.turnCount);
	wrapper.append(element("div", "body", text));
	append(wrapper);
	syncTurnDots();
}

function addError(text) {
	append(element("div", "msg error-block", text));
}

/**
 * Something worth knowing that is not a failure.
 *
 * Deliberately not styled like an error: the model losing sight of older turns
 * is a consequence of the context budget, not a fault, and colouring it red
 * would teach the user to ignore it.
 */
function addNotice(text) {
	append(element("div", "msg notice-block", text));
}

function beginAssistant() {
	const wrapper = element("div", "msg msg-assistant");
	const body = element("div", "body streaming");
	wrapper.append(body);
	append(wrapper);
	state.assistant = body;
}

function addThinking(text) {
	// Accumulate into one panel, like assistant text does. The three bouncing
	// dots stay visible for the whole thinking stream, and the text grows
	// alongside them.
	if (!state.thinking) {
		const wrapper = element("div", "msg msg-assistant");
		const thinking = element("div", "thinking");
		thinking.append(element("span", "thinking-dots"), element("span", "thinking-text", ""));
		wrapper.append(thinking);
		append(wrapper);
		state.thinking = thinking;
	}
	const liveText = state.thinking.querySelector(".thinking-text");
	if (liveText) {
		// The placeholder text is not real reasoning; replace it with the first
		// actual delta rather than appending "thinking…" in front of it.
		if (liveText.textContent === "思考中…") liveText.textContent = "";
		liveText.textContent += text;
	}
}

/**
 * Show a "thinking…" placeholder while the model produces its first output.
 *
 * The gap between the user sending and the first token — or the first tool call
 * — is the one place a reader has *no* feedback at all, whether or not the
 * model is doing explicit reasoning. A bouncing "thinking…" panel fills it; the
 * real output clears it as soon as it arrives.
 */
function beginThinkingPlaceholder() {
	if (state.thinking) return;
	addThinking("");
	const liveText = state.thinking?.querySelector(".thinking-text");
	if (liveText) liveText.textContent = "思考中…";
}

/** End the thinking phase: remove the panel and drop the reference. */
function endThinking() {
	if (state.thinking) {
		state.thinking.remove();
		state.thinking = null;
	}
}

function startTool(event) {
	const wrapper = element("div", "msg");
	const block = element("div", "tool running");
	block.dataset.toolId = event.id;

	const head = element("button", "tool-head");
	head.type = "button";
	const caret = element("span", "tool-caret", "▸");
	const name = element("span", "tool-name", event.name);
	const arg = element("span", "tool-arg", describeArgs(event.args));
	const status = element("span", "tool-state", "运行中");
	head.append(caret, name, arg, status);

	const body = element("pre", "tool-body");

	// Expanding is opt-in: a long output should not push the conversation away.
	head.addEventListener("click", () => {
		block.classList.toggle("open");
		caret.textContent = block.classList.contains("open") ? "▾" : "▸";
	});
	// Double-click opens the whole result in the inspector, where it is not
	// competing with the conversation for width.
	head.addEventListener("dblclick", () => showToolDetail(name.textContent, body.textContent));

	block.append(head, body);
	wrapper.append(block);
	// Not `append()`: tool calls are grouped, and the group has to be created
	// around this node rather than after it.
	setEmptyVisible(false);
	appendToolNode(wrapper);
	autoScroll();

	state.tools.set(event.id, { block, caret, body, status });
}

function updateTool(event) {
	const live = state.tools.get(event.id);
	if (!live) return;
	const text = resultText(event.partial);
	if (text.length > 0) {
		live.body.textContent = text;
		autoScroll();
	}
}

/**
 * Artifacts carried by a tool result, if any.
 *
 * Read out of `details` rather than parsed from the text: the tool already
 * classified each item (kind, size, preview), and re-deriving that in the
 * renderer would be a second implementation to keep in sync.
 */
function artifactsFrom(result) {
	if (typeof result !== "object" || result === null) return [];
	const details = result.details;
	if (typeof details !== "object" || details === null) return [];
	const items = details.items;
	if (!Array.isArray(items)) return [];
	return items.filter((item) => typeof item === "object" && item !== null && typeof item.name === "string");
}

/**
 * Show `+N −M` for a file-mutating call.
 *
 * An `approximate` summary means the real delta could not be computed (the file
 * was too large to compare against). It is shown without the minus count rather
 * than as a delta, because a made-up zero would read as "nothing was removed" —
 * the opposite of what the flag is warning about.
 */
function renderChangeBadge(block, result) {
	if (typeof result !== "object" || result === null) return;
	const details = result.details;
	if (typeof details !== "object" || details === null) return;
	const change = details.change;
	if (typeof change !== "object" || change === null) return;

	const head = block.querySelector(".tool-head");
	if (!head) return;

	const badge = element("span", "change-badge");
	if (change.approximate) {
		badge.textContent = `+${change.added} 行`;
		badge.title = "无法比对原文（文件过大），这里显示的是写入行数，不是增量。";
		badge.classList.add("change-badge--approx");
	} else if (change.created) {
		badge.textContent = `新建 +${change.added}`;
	} else {
		badge.textContent = `+${change.added} −${change.removed}`;
	}
	if (change.created) badge.classList.add("change-badge--new");
	head.append(badge);

	const arg = head.querySelector(".tool-arg");
	if (arg && typeof change.path === "string") arg.textContent = change.path;
}

/** `1234` → `1.2 KB`. Kept in sync with the tool's own formatting. */
function formatSize(bytes) {
	if (typeof bytes !== "number" || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PREVIEW_LABEL = { html: "网页", image: "图片", pdf: "PDF", text: "文本", url: "链接", none: "文件" };

/**
 * Render delivered artifacts as cards under the tool block.
 *
 * A card rather than another line of tool output: this is the part of the turn
 * the user actually asked for, and it should not look like a log entry.
 */
function renderArtifactCards(target, items) {
	const list = element("div", "artifacts");
	for (const item of items) {
		const card = element("button", "artifact");
		card.type = "button";

		const icon = element("span", `artifact-icon artifact-icon--${item.preview ?? "none"}`);
		const text = element("span", "artifact-text");
		const name = element("span", "artifact-name", item.name);
		const meta = element("span", "artifact-meta");
		const kind = PREVIEW_LABEL[item.preview] ?? "文件";
		const size = formatSize(item.size);
		meta.textContent = size.length > 0 ? `${kind} · ${size}` : kind;
		text.append(name, meta);
		card.append(icon, text);

		// A file the model delivered should open with one click, not two. The card
		// opens the file in the OS's default app; a separate "open" affordance is
		// not needed on a card that already has exactly one job. URLs and inline
		// previews are the exception: those go to the inspector instead.
		if (item.kind === "url") {
			card.addEventListener("click", () => openArtifact(item));
		} else {
			card.addEventListener("click", () => void openArtifactExternally(item));
		}
		list.append(card);
	}
	target.append(list);
}

function endTool(event) {
	const live = state.tools.get(event.id);
	if (!live) return;
	// The final result is the complete output, matching how the tools are
	// written; anything streamed before it was a partial view.
	const text = resultText(event.result);
	if (text.length > 0) live.body.textContent = text;

	// What the call did to the file, when it changed one. Shown on the tool row
	// because "the agent edited three files" is only reassuring if the size of
	// each edit is visible.
	renderChangeBadge(live.block, event.result);

	// Delivery is shown as cards instead of as the tool's own one-line summary,
	// which says the same thing in a less useful shape.
	const items = artifactsFrom(event.result);
	if (items.length > 0) {
		live.block.classList.add("tool--delivery");
		renderArtifactCards(live.block, items);
		for (const item of items) state.artifacts.push(item);
		renderArtifactList();
	}

	live.status.textContent = event.isError ? "失败" : "完成";
	live.status.classList.add(event.isError ? "bad" : "ok");
	live.block.classList.remove("running");
	if (event.isError) live.block.classList.add("failed");
	state.tools.delete(event.id);
}

// ------------------------------------------------------------- event routing

function handleEvent(event) {
	switch (event.type) {
		case "run_start":
			state.running = true;
			setRunning(true);
			beginThinkingPlaceholder();
			return;

		// Live runs never emit this — `send()` adds the bubble itself so the
		// message is visible even if the run fails to start. It arrives only
		// when a stored conversation is replayed.
		case "user_message":
			addUserMessage(event.text);
			return;

		case "assistant_start":
			// Thinking is over once the real answer begins: the bouncing dots stop
			// and the panel freezes as a finished thought.
			endThinking();
			beginAssistant();
			return;

		case "text_delta":
			endThinking();
			if (!state.assistant) beginAssistant();
			state.assistant.textContent += event.text;
			autoScroll();
			return;

		case "thinking_delta":
			addThinking(event.text);
			return;

		case "assistant_end":
			// Re-render now that the message is complete and markdown is safe
			// to parse. The streaming class (and its caret) comes off at the same
			// time: a finished reply is not typing.
			if (state.assistant) {
				state.assistant.classList.remove("streaming");
				state.assistant.innerHTML = renderMarkdown(state.assistant.textContent ?? "");
			}
			state.assistant = null;
			autoScroll();
			return;

		case "tool_start":
			endThinking();
			startTool(event);
			return;

		case "tool_update":
			updateTool(event);
			return;

		case "tool_end":
			endTool(event);
			return;

		case "turn_end":
			return;

		case "notice":
			addNotice(event.message);
			return;

		// A status update, not transcript content.
		case "context_status":
			state.context = event.status;
			setStatusLine();
			renderInspector();
			return;

		case "run_end":
			state.running = false;
			setRunning(false);
			// Fold the finished turn's tool runs away. Done here rather than as
			// each call ends, so the last batch stays visible while it is still
			// the thing being watched.
			collapseFinishedToolGroups();
			return;

		case "error":
			addError(event.message);
			return;

		default:
			return;
	}
}

// ------------------------------------------------------------------ controls

function setRunning(running) {
	byId("send").disabled = running;
	byId("abort").hidden = !running;
}

function setStatusLine() {
	const text = byId("status-text");
	const cwd = byId("cwd");
	const session = state.session;

	if (!session) {
		text.textContent = "未启动会话";
		cwd.textContent = "选择工作目录";
		cwd.disabled = true;
		byId("expert-warning").hidden = true;
		byId("footer-model").textContent = "未启动";
		byId("footer-cwd").textContent = "—";
		byId("model-label").textContent = "";
		byId("model-dot").className = "";
		byId("model-trigger").title = "还没有会话";
		closeModelMenu();
		renderInspector();
		return;
	}

	const mode = session.scripted ? " · 脚本化运行" : "";
	const expert = session.expert ? ` · ${session.expert.label}` : "";

	// Whether the agent can reach the network at all is a property of the tool
	// set, not the model — so it is read off the resolved tools, and shown next to
	// the count rather than guessed from the provider. "离线" is the honest word
	// for "no web_search/web_fetch in this mode", which is the state the reader
	// actually wants to distinguish from "it can look things up".
	const canBrowse = (session.tools ?? []).some((name) => name === "web_search" || name === "web_fetch");
	const online = session.scripted ? "" : canBrowse ? " · 联网" : " · 离线";

	// Shown only once the model stops seeing everything. An indicator that is
	// always present becomes furniture, and furniture stops being read — so it
	// stays out of the way until it has something to say.
	const context = state.context;
	const pruned = context && context.visible < context.total ? ` · 模型可见 ${context.visible}/${context.total} 条` : "";

	// Disclosed up front rather than only at the moment of the switch. A reply
	// that came from a different model than the one on the status line is
	// something the user should have known could happen *before* it did — the
	// notice the kernel raises mid-run tells them it happened, not that it could.
	const backup = session.fallback ? ` ⇄ ${session.fallback.provider}/${session.fallback.id}` : "";

	text.textContent = `${session.profile.id}${expert} · ${session.model.provider}/${session.model.id}${backup} · ${session.toolCount} 个工具${online}${mode}${pruned}`;
	cwd.textContent = session.cwd;
	cwd.disabled = false;

	byId("footer-model").textContent = `${session.model.provider}/${session.model.id}`;
	byId("footer-cwd").textContent = session.cwd;
	byId("model-label").textContent = `${session.model.provider}/${session.model.id}${session.scripted ? "（脚本化）" : ""}`;
	// The dot means "this model can actually be called", answered by pi's own
	// resolution layer rather than inferred from what is on disk. It used to mean
	// "scripted run" — which the label already says in words right next to it, and
	// which left the reader with no way to tell a working model from an unusable
	// one at a glance. A grey dot plus a failed first message was the only signal.
	const dot = byId("model-dot");
	dot.className = session.modelReady ? "online" : "";
	byId("model-trigger").title = session.modelReady
		? "切换模型 · 当前模型可以调用"
		: session.scripted
			? "切换模型 · 当前是脚本化运行，不会真的调用模型"
			: "切换模型 · 当前模型没有可用的凭据，发消息会失败";
	// The switcher's list is built around the running session, so a session
	// change leaves it stale. Closing is the honest response: reopening rebuilds
	// it, while a list still highlighting the previous model would be a lie.
	closeModelMenu();

	// An expert written for another mode can narrow the tool set to nothing. That
	// is correct behaviour and completely invisible otherwise — the agent would
	// simply stop using tools — so it is stated outright.
	const unavailable = session.unavailableTools ?? [];
	const warning = byId("expert-warning");
	warning.textContent = unavailable.length > 0 ? `专家要求的工具此模式没有：${unavailable.join("、")}` : "";
	warning.hidden = unavailable.length === 0;

	renderInspector();
}

/**
 * Adopt a session the main process announced: draw whatever it resumed and
 * describe it.
 *
 * Reached through the session subscription rather than from each call site, so
 * starting, clearing, and changing directory all redraw from one place.
 */
function applySession(started) {
	clearTranscript();
	// Artifacts belong to the session, and the main process clears its preview
	// allowlist on every start — keeping them here would offer rows that can no
	// longer be read.
	state.artifacts = [];
	renderArtifactList();
	state.session = started.info;
	state.profileId = started.info.profile.id;
	// The recipe the main process actually used, which can differ from what was
	// asked for when the stored default filled in an omitted expert. Reading it
	// back keeps the picker showing what is really running.
	state.expertId = started.info.expert?.id ?? null;
	syncPickers();
	syncModeSwitch();
	// Nothing has been sent in this session yet, so there is nothing to report
	// about what the model has seen.
	state.context = null;
	setStatusLine();

	if (started.info.resumed > 0) {
		byId("status-text").textContent += ` · 已恢复 ${started.info.resumed} 条消息`;
	} else {
		byId("empty-hint").textContent = started.info.scripted
			? "当前是脚本化运行，用来在没有 API key 时预览界面。发送任意消息即可。"
			: `已就绪：${started.info.profile.label}${started.info.expert ? ` + ${started.info.expert.label}` : ""}。输入消息开始。`;
	}

	// Replayed through the same handler a live run uses, so restored history and
	// new output cannot render differently. This goes last: drawing a message
	// hides the empty state, so anything that writes into it has to run first.
	for (const event of started.history) handleEvent(event);
	// A restored session lands on the newest message. `autoScroll` would not do
	// this — the reader's "scroll up" position has not been set yet, but the
	// distance from the bottom is already large, so it would stay at the top.
	if (started.info.resumed > 0) scrollToBottom();
	void refreshConversations();
}

/**
 * Offer the scripted preview after a session fails to start.
 *
 * Without provider credentials there is no model, so nothing can run and the
 * interface is unreachable — which reads as a broken app rather than an
 * unconfigured one. The preview runs on a scripted transport, so it works
 * regardless of why the real session failed.
 */
function offerPreview(profileId, expertId) {
	const wrapper = element("div", "msg");
	const button = element("button", "ghost", "用脚本化运行预览（不需要 API key）");
	button.type = "button";
	button.addEventListener("click", () => {
		wrapper.remove();
		void startSession(profileId, expertId, { scripted: true });
	});
	wrapper.append(button);
	append(wrapper);
}

/**
 * Start a session for a recipe.
 *
 * `expertId` is `null` for "no expert" and must stay distinct from `undefined`:
 * the main process reads an omitted expert as "use the stored default", so a
 * picker that meant "none" would otherwise be silently overridden.
 *
 * `scripted` is deliberately tri-state: leave it undefined to let the main
 * process decide (the environment variable, or whatever the previous session
 * used), `true` to force the preview. Passing `false` would override the
 * environment rather than defer to it, which silently turns a configured
 * scripted run into a failed start.
 */
async function startSession(profileId, expertId, { fresh = false, scripted } = {}) {
	// Show the transitional state immediately; the redraw arrives with the
	// announcement.
	state.session = null;
	state.profileId = profileId;
	state.expertId = expertId;
	state.context = null;
	clearTranscript();
	syncPickers();
	syncModeSwitch();
	setStatusLine();

	try {
		if (fresh) await window.gdou.newSession(profileId, expertId);
		else await window.gdou.start(profileId, expertId, scripted);
	} catch (error) {
		addError(`无法启动会话：${error.message}`);
		// Already in the preview: offering it again would just loop.
		if (!scripted) offerPreview(profileId, expertId);
	}
}

/** Open a stored conversation. */
async function openSession(id) {
	try {
		await window.gdou.openSession(id);
	} catch (error) {
		addError(`无法打开会话：${error.message}`);
	}
}

/** Switch the working directory: the session is rebuilt against the new one. */
async function adoptCwd(path) {
	try {
		await window.gdou.setCwd(path);
	} catch (error) {
		addError(`无法切换工作目录：${error.message}`);
	}
}

async function send(text) {
	if (state.running || text.trim().length === 0) return;
	if (!state.session) {
		addError("还没有会话。请先选择模式。");
		return;
	}

	addUserMessage(text);
	state.running = true;
	setRunning(true);

	try {
		await window.gdou.prompt(text);
	} catch (error) {
		addError(error.message);
	} finally {
		state.running = false;
		setRunning(false);
	}
}

// ----------------------------------------------------------------- composer

const input = byId("input");

function autoGrow() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

input.addEventListener("input", autoGrow);
input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		byId("composer").requestSubmit();
	}
});

byId("composer").addEventListener("submit", (event) => {
	event.preventDefault();
	const text = input.value;
	input.value = "";
	autoGrow();
	void send(text);
});

byId("abort").addEventListener("click", () => {
	void window.gdou.abort();
});

byId("profile").addEventListener("change", (event) => {
	// The expert carries over: changing the mode is not a request to drop it.
	// A fresh conversation, the same as a launch: switching mode is a deliberate
	// move to a different capability, not a request to drag the previous
	// conversation of that mode back onto the screen. History stays one click
	// away in the list.
	void startSession(event.target.value, state.expertId, { fresh: true });
});

byId("expert").addEventListener("change", (event) => {
	if (state.running || !state.profileId) return;
	// The empty option is "no expert", which has to be sent as null rather than
	// omitted — omitting it would let the stored default come back. A fresh
	// conversation for the same reason as switching mode: the expert shapes the
	// prompt and the tools, so resuming a transcript written under a different
	// one would restore something this recipe never produced.
	void startSession(state.profileId, event.target.value === "" ? null : event.target.value, { fresh: true });
});

function beginNewChat() {
	// Starting over mid-run would discard the run's output as it arrives.
	if (state.running || !state.profileId) return;
	void startSession(state.profileId, state.expertId, { fresh: true });
}

byId("new-chat").addEventListener("click", beginNewChat);
byId("new-chat-inline").addEventListener("click", beginNewChat);
byId("new-chat-sidebar").addEventListener("click", beginNewChat);

byId("cwd").addEventListener("click", async () => {
	if (state.running) return;

	let path;
	try {
		path = await window.gdou.pickDirectory();
	} catch (error) {
		addError(`无法打开目录选择器：${error.message}`);
		return;
	}
	// Cancelling is not an error and changes nothing.
	if (path) await adoptCwd(path);
});

// ------------------------------------------------------------------- history

const historyMenu = byId("history-menu");

function closeHistory() {
	historyMenu.hidden = true;
}

function relativeTime(iso) {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.round((Date.now() - then) / 1000);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
	return `${Math.floor(seconds / 86400)} 天前`;
}

/**
 * Swap a row's title for an input.
 *
 * Commits on Enter or blur, cancels on Escape. The `settled` guard matters:
 * pressing Enter also blurs the field, and without it the rename would be sent
 * twice.
 */
function beginRename(row, titleButton, session) {
	const field = document.createElement("input");
	field.className = "menu-input";
	field.value = session.title;
	field.maxLength = 80;

	row.replaceChild(field, titleButton);
	field.focus();
	field.select();

	let settled = false;
	const finish = async (commit) => {
		if (settled) return;
		settled = true;

		const next = field.value.trim();
		// An empty name is not a rename, it is an accident. Keep the old one.
		if (commit && next.length > 0 && next !== session.title) {
			try {
				await window.gdou.renameSession(session.id, next);
			} catch (error) {
				addError(`无法重命名：${error.message}`);
			}
		}
		await refreshHistory();
	};

	field.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			void finish(true);
		} else if (event.key === "Escape") {
			event.preventDefault();
			void finish(false);
		}
	});
	field.addEventListener("blur", () => void finish(true));
}

function renderHistory(sessions) {
	const current = state.session?.sessionId;

	if (sessions.length === 0) {
		historyMenu.replaceChildren(element("div", "menu-empty", "还没有存下来的对话。"));
		return;
	}

	historyMenu.replaceChildren(
		...sessions.map((session) => {
			const row = element("div", "menu-row");
			if (session.id === current) row.classList.add("current");

			const open = element("button", "menu-item");
			open.type = "button";
			open.append(
				element("span", "menu-title", session.title),
				element("span", "menu-meta", `${relativeTime(session.updatedAt)} · ${session.messageCount} 条`),
			);
			open.addEventListener("click", () => {
				closeHistory();
				if (session.id !== current) void openSession(session.id);
			});

			const rename = element("button", "menu-action", "改名");
			rename.type = "button";
			rename.title = "重命名这条对话";
			rename.addEventListener("click", (event) => {
				event.stopPropagation();
				beginRename(row, open, session);
			});

			const remove = element("button", "menu-remove", "×");
			remove.type = "button";
			remove.title = "删除这条对话";
			remove.addEventListener("click", async (event) => {
				event.stopPropagation();
				try {
					await window.gdou.deleteSession(session.id);
				} catch (error) {
					addError(`无法删除会话：${error.message}`);
				}
				// Deleting the open conversation leaves the window describing
				// something that no longer exists; start a fresh one.
				if (session.id === current && state.profileId) {
					closeHistory();
					await startSession(state.profileId, state.expertId, { fresh: true });
					return;
				}
				await refreshHistory();
			});

			row.append(open, rename, remove);
			return row;
		}),
	);
}

async function refreshHistory() {
	if (!state.profileId) return;
	try {
		renderHistory(await window.gdou.listSessions(state.profileId));
	} catch (error) {
		historyMenu.replaceChildren(element("div", "menu-empty", `无法读取历史：${error.message}`));
	}
}

byId("history-toggle").addEventListener("click", () => {
	if (!historyMenu.hidden) {
		closeHistory();
		return;
	}
	historyMenu.hidden = false;
	historyMenu.replaceChildren(element("div", "menu-empty", "正在读取…"));
	void refreshHistory();
});

// Clicking anywhere else closes the menu.
document.addEventListener("click", (event) => {
	if (historyMenu.hidden) return;
	if (!event.target.closest(".menu-wrap")) closeHistory();
});

// ---------------------------------------------------- sidebar conversations

/**
 * The sidebar list is a quick switcher; the popup behind 历史 carries the
 * rename and delete actions.
 *
 * Both read the same call rather than keeping separate copies, so a rename in
 * one is visible in the other as soon as either refreshes.
 */
async function refreshConversations() {
	const target = byId("conversation-list");
	if (!state.profileId) {
		target.replaceChildren(element("div", "side-empty", "还没有会话。"));
		return;
	}

	let sessions;
	try {
		sessions = await window.gdou.listSessions(state.profileId);
	} catch (error) {
		target.replaceChildren(element("div", "side-empty", `无法读取：${error.message}`));
		return;
	}

	state.sessions = sessions;
	if (sessions.length === 0) {
		target.replaceChildren(element("div", "side-empty", "还没有存下来的对话。"));
		return;
	}

	const current = state.session?.sessionId;
	target.replaceChildren(
		...sessions.map((session) => {
			const row = element("button", "conversation-row");
			row.type = "button";
			if (session.id === current) row.classList.add("active");
			row.append(element("span", null, session.title), element("small", null, relativeTime(session.updatedAt)));
			row.title = session.title;
			row.addEventListener("click", () => {
				if (session.id !== current) void openSession(session.id);
			});
			return row;
		}),
	);
}

// ---------------------------------------------------------------- inspector

function inspectorRow(label, value, done) {
	const li = element("li", done ? "done" : null);
	li.append(icon(["M20 6 9 17l-5-5"], 14), element("span", null, `${label}：${value}`));
	return li;
}

function showToolDetail(name, output) {
	const section = byId("inspector-tools").closest("section");
	const existing = byId("inspector-tool-detail");
	if (existing) existing.remove();

	const box = element("div", "context-item");
	const inner = element("div");
	inner.append(element("b", null, name), element("span", null, "双击工具标题可在这里查看完整输出"));
	const pre = element("pre", "tool-body");
	pre.style.display = "block";
	pre.style.maxHeight = "260px";
	pre.textContent = output || "(无输出)";
	inner.append(pre);
	box.id = "inspector-tool-detail";
	box.append(inner);
	section.append(box);
}

/**
 * Open a delivered file in the OS's default application.
 *
 * The one-click path for a delivered file: this is what the user actually wants
 * when they click a report, image, or video the model produced. Backed by the
 * same `present_files` allowlist as the preview, so it cannot launch an
 * arbitrary path. A failure is surfaced inline rather than swallowed, because a
 * silent "nothing happened" is the worst possible outcome for a click.
 */
async function openArtifactExternally(item) {
	try {
		await window.gdou.openArtifact(item.target);
	} catch (error) {
		addError(`无法打开 ${item.name}：${error.message}`);
	}
}

/**
 * Show a delivered artifact in the inspector.
 *
 * HTML goes into a fully sandboxed iframe (`sandbox=""`), which blocks scripts
 * and same-origin access. An artifact is model-authored content, so letting it
 * run script in the app's origin would hand the model the renderer's privileges
 * — the same reasoning as `contextIsolation`, one layer down.
 */
async function openArtifact(item) {
	const section = byId("inspector-tools").closest("section");
	const existing = byId("inspector-artifact");
	if (existing) existing.remove();

	const box = element("div", "context-item");
	box.id = "inspector-artifact";
	const inner = element("div");
	const head = element("div", "artifact-preview-head");
	head.append(element("b", null, item.name));
	// Everything except a URL can also be opened in its default app, which is the
	// only way to see a file too large to preview inline.
	if (item.kind !== "url") {
		const open = element("button", "artifact-preview-open", "用系统应用打开");
		open.type = "button";
		open.addEventListener("click", () => void openArtifactExternally(item));
		head.append(open);
	}
	inner.append(head);

	if (item.kind === "url") {
		const link = element("a", "artifact-open", item.target);
		link.href = item.target;
		link.target = "_blank";
		link.rel = "noreferrer";
		inner.append(link);
	} else {
		try {
			const data = await window.gdou.readArtifact(item.target);
			if (data.tooLarge) {
				inner.append(
					element(
						"span",
						null,
						`文件 ${formatSize(data.size)}，超过面板预览上限，请点击右上角「用系统应用打开」。`,
					),
				);
			} else if (data.dataUrl) {
				const image = document.createElement("img");
				image.className = "artifact-image";
				image.src = data.dataUrl;
				inner.append(image);
			} else if (item.preview === "html") {
				const frame = document.createElement("iframe");
				frame.className = "artifact-frame";
				frame.setAttribute("sandbox", "");
				frame.srcdoc = data.text;
				inner.append(frame);
			} else {
				const pre = element("pre", "tool-body");
				pre.style.display = "block";
				pre.style.maxHeight = "320px";
				pre.textContent = data.text;
				inner.append(pre);
			}
		} catch (error) {
			inner.append(element("span", null, `无法预览：${error.message}`));
		}
	}

	box.append(inner);
	section.append(box);
}

/** Keep the inspector's artifact list current. */
function renderArtifactList() {
	const box = byId("artifacts");
	if (!box) return;
	if (state.artifacts.length === 0) {
		box.replaceChildren(element("p", "inspector-empty", "本次会话还没有交付产物。"));
		return;
	}
	box.replaceChildren(
		...state.artifacts.map((item) => {
			const row = element("button", "artifact-row");
			row.type = "button";
			row.append(
				element("span", "artifact-row__name", item.name),
				element("span", "artifact-row__meta", PREVIEW_LABEL[item.preview] ?? "文件"),
			);
			// Clicking a delivered file opens it in the default app; a URL opens in
			// the browser. Preview remains reachable from the message cards.
			if (item.kind === "url") {
				row.addEventListener("click", () => void openArtifact(item));
			} else {
				row.addEventListener("click", () => void openArtifactExternally(item));
			}
			return row;
		}),
	);
}

function renderInspector() {
	const session = state.session;

	const sessionList = byId("inspector-session");
	if (!session) {
		sessionList.replaceChildren(element("li", null, "未启动会话"));
	} else {
		sessionList.replaceChildren(
			inspectorRow("模式", session.profile.id, true),
			inspectorRow("专家", session.expert ? `${session.expert.label}（${session.expert.id}）` : "无", Boolean(session.expert)),
			inspectorRow("模型", `${session.model.provider}/${session.model.id}`, true),
			// The row is drawn even when there is no fallback. An absent row is
			// indistinguishable from a build that lacks the feature, and the whole
			// value of disclosing a fallback is that the reader knows it *could*
			// be used before it is.
			inspectorRow(
				"备用模型",
				session.fallback ? `${session.fallback.provider}/${session.fallback.id}` : "未配置",
				Boolean(session.fallback),
			),
			inspectorRow("工具", `${session.toolCount} 个`, session.toolCount > 0),
			inspectorRow("工作目录", session.cwd, true),
		);
	}

	const contextBox = byId("inspector-context");
	const context = state.context;
	if (!context) {
		contextBox.replaceChildren(
			element("p", "inspector-empty", "还没有发过请求，所以还没有什么可报告的。"),
		);
	} else {
		const used = Math.min(100, Math.round((context.visibleChars / context.budgetChars) * 100));
		const bar = element("div", `context-bar${used > 85 ? " warn" : ""}`);
		const fill = element("i");
		fill.style.width = `${used}%`;
		bar.append(fill);

		const item = element("div", "context-item");
		const inner = element("div");
		inner.append(
			element("b", null, `模型可见 ${context.visible} / ${context.total} 条`),
			element("span", null, `${context.visibleChars} / ${context.budgetChars} 字符（${used}%）`),
		);
		item.append(inner);
		contextBox.replaceChildren(item, bar);
	}

	const toolsBox = byId("inspector-tools");
	const note = byId("inspector-tools-note");
	const names = session?.tools ?? [];
	if (names.length === 0) {
		toolsBox.replaceChildren();
		note.textContent = session
			? "这个会话没有工具可用。专家只能收窄工具集，所以为别的模式写的专家可能把它收窄到空。"
			: "未启动会话。";
	} else {
		toolsBox.replaceChildren(...names.map((name) => {
			const li = element("li");
			li.append(element("span", "tool-chip", name));
			return li;
		}));
		note.textContent = "";
	}
}

/** Drag the divider to trade width between the conversation and the inspector. */
function wireInspectorDivider() {
	const divider = byId("layout-divider");
	const layout = byId("work-layout");

	const onMove = (event) => {
		const right = layout.getBoundingClientRect().right;
		const width = Math.min(Math.max(right - event.clientX, 280), Math.max(320, right - 420));
		document.documentElement.style.setProperty("--inspector-width", `${Math.round(width)}px`);
	};

	const onUp = () => {
		document.body.classList.remove("inspector-resizing");
		document.removeEventListener("mousemove", onMove);
		document.removeEventListener("mouseup", onUp);
	};

	divider.addEventListener("mousedown", (event) => {
		event.preventDefault();
		document.body.classList.add("inspector-resizing");
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	});
}

function setInspectorVisible(visible) {
	state.inspectorVisible = visible;
	byId("inspector").hidden = !visible;
	byId("layout-divider").hidden = !visible;
	byId("work-layout").classList.toggle("no-inspector", !visible);
}

// ------------------------------------------------------------------- views

const VIEWS = ["chat", "experts", "automation", "skills", "settings"];

function setView(view) {
	state.view = view;
	for (const name of VIEWS) {
		const node = byId(`view-${name}`);
		if (node) node.hidden = name !== view;
	}
	byId("diagnostics").hidden = view !== "diagnostics";

	for (const button of byId("primary-nav").querySelectorAll("button")) {
		button.classList.toggle("active", button.dataset.view === view);
	}

	if (view === "experts") void refreshExperts();
	if (view === "skills") void refreshSkills();
	if (view === "settings") void refreshCredentials();
	if (view === "diagnostics") void loadDiagnostics();
}

for (const button of byId("primary-nav").querySelectorAll("button")) {
	button.addEventListener("click", () => setView(button.dataset.view));
}

// ------------------------------------------------------------------ experts

/**
 * Modes shown in the sidebar switch.
 *
 * Not every mode: the switch is a segmented control two cells wide, and modes
 * are now files anyone can add, so the list can be any length. The shipped modes
 * come first in the catalog order and are the ones people switch between;
 * anything else is reachable from the picker, which always lists everything.
 * Capping here rather than growing the control keeps one mode from being
 * squeezed to nothing when someone has written six.
 */
const MODE_SWITCH_LIMIT = 2;

/** The mode switch mirrors the picker, so the two cannot disagree. */
function syncModeSwitch() {
	for (const button of byId("mode-switch").querySelectorAll("button")) {
		button.classList.toggle("active", button.dataset.mode === state.profileId);
	}
}

function renderModeSwitch(profiles) {
	byId("mode-switch").replaceChildren(
		...profiles.slice(0, MODE_SWITCH_LIMIT).map((profile) => {
			const button = element("button", null, profile.label);
			button.type = "button";
			button.dataset.mode = profile.id;
			button.title = profile.description;
			button.addEventListener("click", () => {
				if (state.running || profile.id === state.profileId) return;
				// A fresh conversation, the same as a launch and as the picker:
				// switching mode moves to a different capability, not back into
				// the previous conversation of that mode.
				void startSession(profile.id, state.expertId, { fresh: true });
			});
			return button;
		}),
	);
	syncModeSwitch();
}

/**
 * Show the experts that loaded, and any file that did not.
 *
 * The failures are listed rather than swallowed: a malformed expert file is
 * otherwise indistinguishable from one that was never written, and the picker
 * would simply not offer it with no indication why.
 */
function renderExperts(target, catalog) {
	const cards = catalog.experts.map((expert) => {
		const card = element("button", "expert-card");
		card.type = "button";
		if (expert.id === state.expertId) card.classList.add("active");

		const head = element("div", "expert-card__head");
		head.append(icon(["M12 3l2.5 5.5L20 10l-4 4 1 6-5-2.8L7 20l1-6-4-4 5.5-1.5Z"], 16), element("b", null, expert.label));
		head.append(element("span", "expert-card__id", expert.id));
		card.append(head);

		card.append(element("p", null, expert.description));

		const foot = element("div", "expert-card__foot");
		// "Declares" rather than "narrows to": this is the size of the expert's
		// own allowlist, and how much of it survives depends on the mode. The
		// effective set is shown by `--list-tools` and by the inspector.
		if (expert.tools && expert.tools.length > 0) {
			foot.append(element("span", "tool-chip", `声明 ${expert.tools.length} 个工具`));
		} else if (expert.tools) {
			foot.append(element("span", "tool-chip tool-chip--none", "声明 0 个工具"));
		} else {
			foot.append(element("span", "tool-chip tool-chip--none", "不收窄工具集"));
		}
		if (expert.thinkingLevel) foot.append(element("span", "tool-chip", `thinking: ${expert.thinkingLevel}`));
		if (expert.id === state.expertId) foot.append(element("span", "expert-card__badge", "使用中"));
		card.append(foot);

		card.title = `用「${expert.label}」开始一个新会话`;
		card.addEventListener("click", () => {
			if (state.running) return;
			setView("chat");
			void startSession(state.profileId ?? "general", expert.id, { fresh: true });
		});
		return card;
	});

	for (const error of catalog.errors ?? []) {
		const card = element("div", "expert-card expert-card--error");
		const head = element("div", "expert-card__head");
		head.append(icon(["M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"], 16));
		head.append(element("b", null, "无法加载"));
		card.append(head, element("p", null, error));
		cards.push(card);
	}

	if (cards.length === 0) {
		target.replaceChildren(element("p", "inspector-empty", "（没有专家）"));
	} else {
		target.replaceChildren(...cards);
	}
}

/** Where the loader looks, so "where do I put my own expert" has an answer. */
function renderExpertPaths() {
	const box = byId("expert-paths");
	box.replaceChildren();
	const paths = state.expertCatalog?.paths ?? [];
	if (paths.length === 0) return;

	const card = element("div", "planned-card");
	card.append(icon(["M3 7a2 2 0 0 1 2-2h3.6l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"], 18));
	const inner = element("div");
	inner.append(
		element("h2", null, "自己写一个"),
		element("p", null, "一个 markdown 文件，frontmatter 放元数据，正文就是方法论。同名时项目级优先。"),
	);
	const pre = element("pre", "tool-body");
	pre.style.display = "block";
	pre.textContent = paths.join("\n");
	inner.append(pre);
	card.append(inner);
	box.append(card);
}

async function refreshExperts() {
	try {
		const catalog = await window.gdou.experts();
		state.expertCatalog = catalog;
		renderExperts(byId("experts"), catalog);
		renderExpertPaths();
	} catch (error) {
		byId("experts").replaceChildren(element("p", "inspector-empty", `无法读取专家列表：${error.message}`));
	}
}

byId("experts-refresh").addEventListener("click", () => void refreshExperts());

/* ---------------------------------------------------------------- skills */

function renderSkills(target, catalog) {
	const cards = catalog.skills.map((skill) => {
		const card = element("div", "expert-card");

		const head = element("div", "expert-card__head");
		head.append(icon(["M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5ZM20 5.5A1.5 1.5 0 0 0 18.5 4H14v16h4.5a1.5 1.5 0 0 0 1.5-1.5Z"], 16), element("b", null, skill.label));
		head.append(element("span", "expert-card__id", skill.id));
		card.append(head);

		card.append(element("p", null, skill.description));

		const foot = element("div", "expert-card__foot");
		if (skill.whenToUse) foot.append(element("span", "tool-chip", `触发：${skill.whenToUse}`));
		if (skill.references && skill.references.length > 0) {
			foot.append(element("span", "tool-chip", `refs: ${skill.references.join(", ")}`));
		} else {
			foot.append(element("span", "tool-chip tool-chip--none", "无参考文件"));
		}
		card.append(foot);

		return card;
	});

	if (cards.length === 0) {
		target.replaceChildren(element("p", "inspector-empty", "（没有技能）"));
	} else {
		target.replaceChildren(...cards);
	}
}

/** Where the loader looks, so "where do I put my own skill" has an answer. */
function renderSkillPaths() {
	const box = byId("skill-paths");
	box.replaceChildren();
	const paths = state.skillCatalog?.paths ?? [];
	if (paths.length === 0) return;

	const card = element("div", "planned-card");
	card.append(icon(["M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5ZM20 5.5A1.5 1.5 0 0 0 18.5 4H14v16h4.5a1.5 1.5 0 0 0 1.5-1.5Z"], 18));
	const inner = element("div");
	inner.append(
		element("h2", null, "自己写一个"),
		element("p", null, "一个目录，里面放 SKILL.md（frontmatter 放元数据，正文是方法论），可选的 references/ 放参考文件。同名时项目级优先。"),
	);
	const pre = element("pre", "tool-body");
	pre.style.display = "block";
	pre.textContent = paths.join("\n");
	inner.append(pre);
	card.append(inner);
	box.append(card);
}

async function refreshSkills() {
	try {
		const catalog = await window.gdou.skills();
		state.skillCatalog = catalog;
		renderSkills(byId("skills"), catalog);
		renderSkillPaths();
	} catch (error) {
		byId("skills").replaceChildren(element("p", "inspector-empty", `无法读取技能列表：${error.message}`));
	}
}

byId("skills-refresh").addEventListener("click", () => void refreshSkills());

/** Reflect the running recipe in the two pickers. */
function syncPickers() {
	byId("profile").value = state.profileId ?? "";
	byId("expert").value = state.expertId ?? "";
}

// ------------------------------------------------------------ model picker

/**
 * The model switcher in the composer.
 *
 * Ported in shape from the shell this interface follows (its
 * `ModelConfigMenu`): a trigger showing the running model, a popover listing
 * everything usable grouped by provider, and a gear that jumps to the page where
 * keys are entered.
 *
 * The list is built from *configured* providers only. A model whose provider has
 * no credential produces a click that fails later, at request time, as an
 * authentication error several steps away from the choice that caused it — and
 * the user has no reason to connect the two.
 *
 * Nothing is fetched until the menu is opened. The catalogue is thousands of
 * entries across every provider, and building it on every session change to
 * serve a popover that is usually closed would be work for nothing.
 */

function modelMenuOpen() {
	return byId("model-menu").hidden === false;
}

function closeModelMenu() {
	byId("model-menu").hidden = true;
	byId("model-trigger").setAttribute("aria-expanded", "false");
}

/**
 * Place the menu against the trigger.
 *
 * The menu lives on `body` now, so its coordinates are the viewport's and the
 * trigger's rect is the only thing tying it back. Recomputed on resize, because
 * the window can be resized while it is open; not on scroll, because the composer
 * is pinned to the bottom of the layout and does not move when the transcript
 * scrolls.
 */
function positionModelMenu() {
	const menu = byId("model-menu");
	const rect = byId("model-trigger").getBoundingClientRect();
	// Held inside the viewport: on a narrow window the menu is as wide as the
	// window allows, and anchoring it to the trigger's right edge would push it
	// off — a popover partly off-screen is one the reader has to guess at.
	menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
	menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
}

async function toggleModelMenu() {
	if (modelMenuOpen()) {
		closeModelMenu();
		return;
	}
	positionModelMenu();
	byId("model-menu").hidden = false;
	byId("model-trigger").setAttribute("aria-expanded", "true");
	await buildModelMenu();
}

async function buildModelMenu() {
	const list = byId("model-menu-list");
	const note = byId("model-menu-note");
	list.replaceChildren();
	note.textContent = "正在读取…";

	let snapshot;
	try {
		snapshot = await window.gdou.credentials();
	} catch (error) {
		note.textContent = `读不到凭据状态：${error.message}`;
		return;
	}

	const usable = snapshot.providers.filter((row) => row.source);
	const entries = [];
	for (const row of usable) {
		let models = [];
		try {
			models = await window.gdou.models(row.providerId);
		} catch {
			models = [];
		}
		for (const model of models) {
			entries.push({ spec: `${row.providerId}/${model.id}`, name: model.name || model.id, vendor: row.label });
		}
	}

	const current = state.session?.model;
	const runningSpec = current ? `${current.provider}/${current.id}` : null;
	// The running model is listed even when its provider has no credential — a
	// mode file can pin one. Omitting it would leave the status line naming a
	// model this control cannot show, which reads as the control being broken.
	if (runningSpec && !entries.some((entry) => entry.spec === runningSpec)) {
		entries.unshift({ spec: runningSpec, name: current.name || current.id, vendor: current.provider });
	}

	if (entries.length === 0) {
		note.textContent = "没有可用的模型。先到「设置」里配置一个服务商的 key。";
		return;
	}

	let lastVendor = null;
	for (const entry of entries) {
		// One heading per provider, not one per row: with four models behind a
		// single provider, repeating its name on every row is noise.
		if (entry.vendor !== lastVendor) {
			lastVendor = entry.vendor;
			list.append(element("p", "model-menu-group", entry.vendor));
		}

		const item = element("button", "model-menu-item");
		item.type = "button";
		item.setAttribute("role", "menuitemradio");
		const isCurrent = entry.spec === runningSpec;
		item.setAttribute("aria-checked", isCurrent ? "true" : "false");
		// The spec is carried on the element so a check can assert what choosing this
		// row would actually select, rather than matching on a display name.
		item.dataset.spec = entry.spec;
		item.append(element("b", null, entry.name));
		if (isCurrent) item.append(icon(["M4 12.5 9.5 18 20 6.5"], 14));
		item.addEventListener("click", () => void chooseModel(entry, item));
		list.append(item);
	}

	note.textContent = "只列出已配置的服务商 · 在「设置」里可以再加";
}

async function chooseModel(entry, item) {
	if (item.getAttribute("aria-checked") === "true") {
		closeModelMenu();
		return;
	}
	item.disabled = true;
	const note = byId("model-menu-note");
	note.textContent = `正在切换到 ${entry.name}…`;
	try {
		await window.gdou.setModel(entry.spec);
		closeModelMenu();
		// The session announcement redraws the transcript and the label; the
		// settings page is refreshed too so its picker cannot disagree.
		if (state.view === "settings") await refreshCredentials();
	} catch (error) {
		note.textContent = `切换失败：${error.message}`;
		item.disabled = false;
	}
}

byId("model-trigger").addEventListener("click", (event) => {
	event.stopPropagation();
	void toggleModelMenu();
});

byId("model-manage").addEventListener("click", (event) => {
	event.stopPropagation();
	closeModelMenu();
	setView("settings");
});

// The popover floats over the transcript, so it has to close the ways a popover
// does: a click anywhere else, or Escape.
document.addEventListener("pointerdown", (event) => {
	if (!modelMenuOpen()) return;
	// Both the trigger and the menu count as "inside". The menu is a child of
	// `body`, not of the trigger's wrapper, so testing the wrapper alone would
	// treat every press on a menu row as a press outside — the menu would close
	// on pointerdown, before the row's own click handler ran, and picking a model
	// would silently do nothing. The regression test for this is
	// "clicking a menu row applies it".
	if (byId("model-trigger").contains(event.target)) return;
	if (byId("model-menu").contains(event.target)) return;
	closeModelMenu();
});

window.addEventListener("resize", () => {
	if (modelMenuOpen()) positionModelMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && modelMenuOpen()) closeModelMenu();
});

// -------------------------------------------------------------- credentials

/**
 * The model-and-credentials page.
 *
 * Three rules shape it, and each exists because the obvious alternative is
 * wrong:
 *
 * - **No key is ever read back into this page.** A row shows whether a provider
 *   is configured and a masked hint, which answers "which key is installed"
 *   without the value existing in a context that can be logged or screenshotted.
 * - **The picker offers configured providers only.** A dropdown listing models
 *   that cannot be called is a trap rather than a choice, and the failure would
 *   arrive later, as an authentication error, far from the selection.
 * - **Saving a key does not restart a working session.** The model is resolved
 *   when a session is built and credentials are read per request, so a running
 *   session picks the new key up by itself. Rebuilding would throw away the
 *   conversation on screen to achieve nothing.
 */

/** Temporarily replace a button's label with the outcome, then put it back. */
function flash(button, text, ms = 1500) {
	const original = button.textContent;
	button.textContent = text;
	setTimeout(() => {
		button.textContent = original;
	}, ms);
}

/** What a provider's state reads as, in one phrase. */
function credentialLabel(row) {
	const hint = row.hint ? ` · ${row.hint}` : "";
	if (row.source === "stored") return `已配置${hint}`;
	if (row.source === "environment") return `已配置（环境变量）${hint}`;
	return "未配置";
}

function renderCredentials(target, rows) {
	target.replaceChildren(
		...rows.map((row) => {
			const card = element("div", "cred-row");

			const head = element("div", "cred-head");
			head.append(element("b", null, row.label));
			const pill = element("span", "status-pill", credentialLabel(row));
			if (!row.source) pill.classList.add("status-pill--idle");
			head.append(pill);
			card.append(head);

			if (row.envVar) card.append(element("p", "cred-note", `对应环境变量：${row.envVar}`));

			const form = element("div", "cred-form");
			const input = element("input", "cred-input");
			// A password field rather than text: the value is about to be stored
			// on disk and never shown again, so there is no reading it back off
			// the screen that we would want to make easy.
			input.type = "password";
			input.placeholder = row.source === "stored" ? "粘贴新 key 以替换" : "粘贴 API key";
			input.autocomplete = "off";
			input.spellcheck = false;

			const save = element("button", "outline-button", "保存");
			save.type = "button";
			save.addEventListener("click", () => void saveCredential(row, input, save));

			const remove = element("button", "ghost", "删除");
			remove.type = "button";
			// Only a stored key is ours to delete. A key that came from the
			// environment has no file behind it, and an enabled button would
			// promise a deletion that cannot happen.
			remove.disabled = row.source !== "stored";
			remove.addEventListener("click", () => void removeCredential(row, remove));

			form.append(input, save, remove);
			card.append(form);
			return card;
		}),
	);
}

async function refreshCredentials() {
	try {
		const snapshot = await window.gdou.credentials();
		state.credentials = snapshot.providers;
		byId("auth-path").textContent = snapshot.authPath;
		renderCredentials(byId("credential-list"), snapshot.providers);
		await renderModelPicker(snapshot.providers);
	} catch (error) {
		byId("credential-list").replaceChildren(
			element("p", "inspector-empty", `无法读取凭据状态：${error.message}`),
		);
	}
}

async function saveCredential(row, input, button) {
	const key = input.value.trim();
	if (key.length === 0) {
		flash(button, "先粘贴 key");
		return;
	}
	button.disabled = true;
	try {
		const snapshot = await window.gdou.setCredential(row.providerId, key);
		input.value = "";
		state.credentials = snapshot.providers;
		renderCredentials(byId("credential-list"), snapshot.providers);
		await renderModelPicker(snapshot.providers);
		await adoptCredentialsIfIdle(snapshot.providers);
		flash(button, "已保存");
	} catch (error) {
		addError(`保存 key 失败：${error.message}`);
		flash(button, "失败");
	} finally {
		button.disabled = false;
	}
}

async function removeCredential(row, button) {
	button.disabled = true;
	try {
		const snapshot = await window.gdou.removeCredential(row.providerId);
		state.credentials = snapshot.providers;
		renderCredentials(byId("credential-list"), snapshot.providers);
		await renderModelPicker(snapshot.providers);
	} catch (error) {
		addError(`删除 key 失败：${error.message}`);
		flash(button, "失败");
	} finally {
		button.disabled = false;
	}
}

/**
 * Turn a window that had no credentials into a working one.
 *
 * This is the point of the page: someone who just pasted a key expects the
 * application to start working, not to be told to relaunch. Guarded on there
 * being nothing to disturb — a live session keeps running, because credentials
 * are read per request and a rebuild would discard the conversation on screen.
 */
async function adoptCredentialsIfIdle(providers) {
	if (!providers.some((row) => row.source)) return;
	if (state.running) return;
	if (state.session && !state.session.scripted) return;
	// `scripted: false` is passed explicitly, and that is the whole point. An
	// omitted value means "no opinion", which the main process resolves as "keep
	// whatever was running" — so a session started from the preview button stayed
	// on the scripted transport after a key was saved, and the user went on
	// getting the canned replies while believing they were talking to a model.
	await startSession(state.profileId ?? "general", state.expertId ?? null, { scripted: false });
}

function formatContext(tokens) {
	if (typeof tokens !== "number" || tokens <= 0) return "";
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

/** Fill the model dropdown for one provider, keeping the running choice if it is this one. */
async function loadModelsFor(providerId, current) {
	const modelSelect = byId("model-id");
	modelSelect.disabled = true;
	let models = [];
	try {
		models = await window.gdou.models(providerId);
	} catch (error) {
		byId("model-note").textContent = `读不到模型列表：${error.message}`;
		return;
	}
	if (models.length === 0) {
		modelSelect.replaceChildren(element("option", null, "（内置目录里没有模型）"));
		byId("model-note").textContent = `pi 的内置目录里没有 ${providerId} 的模型，这个服务商只能用环境变量指定。`;
		return;
	}
	modelSelect.replaceChildren(
		...models.map((model) => {
			const context = formatContext(model.contextWindow);
			const option = element("option", null, `${model.name || model.id}${context ? ` · ${context}` : ""}`);
			option.value = `${providerId}/${model.id}`;
			return option;
		}),
	);
	modelSelect.disabled = false;
	const running = current && current.provider === providerId ? `${providerId}/${current.id}` : null;
	modelSelect.value = running ?? modelSelect.options[0].value;
	updateModelNote();
}

/**
 * Say what applying the current selection would do.
 *
 * Worth the words: switching rebuilds the session, and a control that silently
 * discards the conversation on screen is one people learn not to touch.
 */
function updateModelNote() {
	const spec = byId("model-id").value;
	const current = state.session?.model;
	const note = byId("model-note");
	if (!spec) {
		note.textContent = "先配置一个服务商的 key。";
		return;
	}
	if (!current) {
		note.textContent = `当前没有会话。应用 ${spec} 会用它新建一个。`;
		return;
	}
	const running = `${current.provider}/${current.id}`;
	note.textContent =
		running === spec ? `正在使用：${spec}` : `运行中：${running}。应用后会用 ${spec} 重建会话。`;
}

/**
 * Fill both pickers on the settings page.
 *
 * Providers come from the rows that are actually configured, and the running
 * model's provider is prepended even when it is not among them — otherwise the
 * status line would name a model the picker cannot show, which reads as the
 * control being broken rather than as the credential being missing.
 */
async function renderModelPicker(providers) {
	const providerSelect = byId("model-provider");
	const modelSelect = byId("model-id");
	const current = state.session?.model;

	const ids = providers.filter((row) => row.source).map((row) => row.providerId);
	if (current && !ids.includes(current.provider)) ids.unshift(current.provider);

	if (ids.length === 0) {
		providerSelect.replaceChildren(element("option", null, "尚未配置"));
		providerSelect.disabled = true;
		modelSelect.replaceChildren();
		modelSelect.disabled = true;
		byId("model-note").textContent = "还没有任何服务商配置好，所以没有模型可选。";
		return;
	}

	providerSelect.disabled = false;
	providerSelect.replaceChildren(
		...ids.map((id) => {
			const option = element("option", null, providers.find((row) => row.providerId === id)?.label ?? id);
			option.value = id;
			return option;
		}),
	);
	providerSelect.value = current && ids.includes(current.provider) ? current.provider : ids[0];
	await loadModelsFor(providerSelect.value, current);
}

byId("credentials-refresh").addEventListener("click", () => void refreshCredentials());

byId("model-provider").addEventListener("change", () =>
	void loadModelsFor(byId("model-provider").value, state.session?.model),
);

byId("model-id").addEventListener("change", () => updateModelNote());

byId("model-apply").addEventListener("click", async () => {
	const spec = byId("model-id").value;
	if (!spec) return;
	try {
		await window.gdou.setModel(spec);
		await refreshCredentials();
	} catch (error) {
		addError(`切换模型失败：${error.message}`);
	}
});

byId("model-reset").addEventListener("click", async () => {
	try {
		await window.gdou.setModel("");
		await refreshCredentials();
	} catch (error) {
		addError(`恢复默认模型失败：${error.message}`);
	}
});

// -------------------------------------------------------------- diagnostics

function renderKV(target, rows) {
	target.replaceChildren(
		...rows.flatMap(([label, value, tone]) => {
			const dt = element("dt", null, label);
			const dd = element("dd", null, value);
			if (tone) dd.className = tone;
			return [dt, dd];
		}),
	);
}

function renderProfiles(target, profiles) {
	target.replaceChildren(
		...profiles.map((profile) => {
			const item = element("li");
			item.append(element("div", "name", profile.id), element("div", "desc", `${profile.label} — ${profile.description}`));
			// The file is named only when there is one. A built-in mode has no file
			// to point at, and printing "built-in" on every shipped row is noise;
			// when a mode did come from a file, that path is the one fact that
			// answers "why is this mode not behaving as I wrote it".
			if (profile.source && !profile.source.startsWith("(built-in)")) {
				item.append(element("div", "source", profile.source));
			}
			return item;
		}),
	);
}

function yesNo(flag) {
	return flag ? ["是", "yes"] : ["否", "no"];
}

/** Loaded lazily: the panel is not the point of the app, and the probe is not free. */
async function loadDiagnostics() {
	const status = byId("status");
	status.textContent = "正在读取内核状态…";
	status.className = "status status--wait";

	let probe;
	try {
		probe = await window.gdou.probe();
	} catch (error) {
		status.textContent = `读取内核状态失败：${error.message}`;
		status.className = "status status--bad";
		return;
	}

	renderKV(byId("versions"), [
		["Electron", probe.versions.electron],
		["Node", probe.versions.node],
		["Chromium", probe.versions.chrome],
	]);

	renderKV(byId("paths"), [
		["项目根", probe.paths.projectRoot],
		["pi 源码", probe.paths.piSource],
		["状态目录", probe.paths.agentHome],
		["日志目录", probe.paths.logsDir],
		["工具目录", probe.paths.toolBinDir],
		["esbuild 打包", ...yesNo(probe.paths.bundled)],
		["app.isPackaged", ...yesNo(probe.paths.packaged)],
	]);

	const binaries = probe.binaries;
	const ready = [...binaries.provisioned, ...binaries.present];
	renderKV(byId("binaries"), [
		["随包来源", binaries.source],
		["已就位", ready.length > 0 ? ready.join(", ") : "无"],
		["本次投放", binaries.provisioned.length > 0 ? binaries.provisioned.join(", ") : "无需投放"],
		["缺失", binaries.missing.length > 0 ? binaries.missing.join(", ") : "无"],
		["错误", binaries.errors.length > 0 ? binaries.errors.join("; ") : "无"],
	]);

	renderProfiles(byId("profiles"), probe.profiles);

	renderKV(byId("models"), [
		["模型总数", String(probe.models.total)],
		["provider 数", String(probe.models.providers)],
	]);

	byId("credentials").textContent = probe.credentials;

	const agent = byId("agent");
	agent.textContent = probe.agent.detail;
	agent.className = `probe ${probe.agent.ok ? "ok" : "bad"}`;

	status.textContent = probe.agent.ok
		? "内核已在 Electron 内成功构建会话"
		: "内核已加载，未构建会话 — 缺少 API key 属于预期结果";
	status.className = `status ${probe.agent.ok ? "status--ok" : "status--warn"}`;
}

byId("diag-toggle").addEventListener("click", () => setView("diagnostics"));
byId("diag-close").addEventListener("click", () => setView("chat"));

// ------------------------------------------------------------------- theme

const THEME_KEY = "gdou-theme";

function applyTheme(theme) {
	document.documentElement.dataset.appTheme = theme;
}

function currentTheme() {
	const stored = localStorage.getItem(THEME_KEY);
	if (stored === "light" || stored === "dark") return stored;
	// No explicit choice yet: follow the OS rather than imposing a default,
	// which is what a user who has already themed their desktop expects.
	return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toggleTheme() {
	const next = document.documentElement.dataset.appTheme === "dark" ? "light" : "dark";
	localStorage.setItem(THEME_KEY, next);
	applyTheme(next);
}

applyTheme(currentTheme());
byId("theme-toggle").addEventListener("click", toggleTheme);

// ---------------------------------------------------------------- titlebar

function wireWindowControls() {
	const send = (channel) => () => void window.gdou.window?.[channel]?.();

	byId("win-minimize").addEventListener("click", send("minimize"));
	byId("win-maximize").addEventListener("click", send("toggleMaximize"));
	byId("win-close").addEventListener("click", send("close"));

	window.gdou.onWindowState?.((maximized) => {
		byId("win-maximize").setAttribute("aria-label", maximized ? "还原" : "最大化");
	});
}

function wireNavToggle() {
	const shell = byId("shell");
	byId("nav-toggle").addEventListener("click", () => {
		shell.classList.add("sidebar-animating");
		shell.classList.toggle("sidebar-collapsed");
		// The transition is only wanted for this toggle; leaving it on would also
		// animate window resizes, where it reads as lag.
		setTimeout(() => shell.classList.remove("sidebar-animating"), 220);
	});
}

/* ---------------------------------------------------------- sidebar resize */

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const SIDEBAR_KEY = "gdou.sidebarWidth";

function applySidebarWidth(width) {
	const shell = byId("shell");
	shell.style.setProperty("--sidebar-w", `${width}px`);
}

function readSidebarWidth() {
	const stored = Number(localStorage.getItem(SIDEBAR_KEY));
	if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) return stored;
	return 240;
}

/**
 * Draggable sidebar. The grid tracks `--sidebar-w`, so the drag only writes one
 * CSS variable; the resizer's `left` follows it through the same variable, which
 * is why the two can never disagree. The width is persisted so the next launch
 * opens at the size the user left it at.
 */
function wireSidebarResizer() {
	const shell = byId("shell");
	const resizer = byId("sidebar-resizer");

	applySidebarWidth(readSidebarWidth());

	resizer.addEventListener("pointerdown", (event) => {
		if (shell.classList.contains("sidebar-collapsed")) return;
		event.preventDefault();
		resizer.setPointerCapture(event.pointerId);
		resizer.classList.add("dragging");

		const onMove = (moveEvent) => {
			const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, moveEvent.clientX));
			applySidebarWidth(width);
		};
		const onUp = () => {
			resizer.classList.remove("dragging");
			resizer.removeEventListener("pointermove", onMove);
			resizer.removeEventListener("pointerup", onUp);
			const width = readSidebarWidth();
			// Persist the value that is currently applied, not the last stored one.
			const applied = Number.parseFloat(getComputedStyle(shell).getPropertyValue("--sidebar-w"));
			if (Number.isFinite(applied)) localStorage.setItem(SIDEBAR_KEY, String(Math.round(applied)));
		};
		resizer.addEventListener("pointermove", onMove);
		resizer.addEventListener("pointerup", onUp);
	});
}

// ------------------------------------------------------------- menu bar

function closeMenus() {
	for (const popover of document.querySelectorAll(".app-menu-popover")) popover.hidden = true;
	for (const trigger of document.querySelectorAll(".app-menu-item > button")) trigger.setAttribute("aria-expanded", "false");
}

const MENU_COMMANDS = {
	"new-chat": beginNewChat,
	"pick-cwd": () => byId("cwd").click(),
	quit: () => void window.gdou.window?.close?.(),
	"view-chat": () => setView("chat"),
	"view-experts": () => setView("experts"),
	"view-automation": () => setView("automation"),
	"view-skills": () => setView("skills"),
	"toggle-inspector": () => setInspectorVisible(!state.inspectorVisible),
	"toggle-theme": toggleTheme,
	diagnostics: () => setView("diagnostics"),
	about: () =>
		addNotice(
			"Gdouwork — 基于 pi 内核的自定义 agent。内核跑在 Electron 主进程内，渲染进程零构建；模式决定能做什么，专家决定该怎么想。",
		),
};

function wireMenuBar() {
	for (const trigger of byId("app-menu-bar").querySelectorAll(".app-menu-item > button")) {
		trigger.addEventListener("click", (event) => {
			event.stopPropagation();
			const popover = trigger.parentElement.querySelector(".app-menu-popover");
			const wasOpen = popover && !popover.hidden;
			closeMenus();
			if (popover && !wasOpen) {
				popover.hidden = false;
				trigger.setAttribute("aria-expanded", "true");
			}
		});
	}

	for (const button of byId("app-menu-bar").querySelectorAll("[data-command]")) {
		button.addEventListener("click", () => {
			closeMenus();
			MENU_COMMANDS[button.dataset.command]?.();
		});
	}

	document.addEventListener("click", (event) => {
		if (!event.target.closest(".app-menu-item")) closeMenus();
	});
}

// -------------------------------------------------------------- shortcuts

document.addEventListener("keydown", (event) => {
	if (!event.ctrlKey && !event.metaKey) return;
	const key = event.key.toLowerCase();

	if (key === "n") {
		event.preventDefault();
		beginNewChat();
		return;
	}
	const index = ["1", "2", "3", "4", "5"].indexOf(key);
	if (index !== -1) {
		event.preventDefault();
		setView(VIEWS[index]);
		return;
	}
	if (key === "b") {
		event.preventDefault();
		byId("nav-toggle").click();
		return;
	}
	if (key === "i") {
		event.preventDefault();
		setInspectorVisible(!state.inspectorVisible);
	}
});

// -------------------------------------------------------------- empty hints

/**
 * A few concrete openers, so the empty state suggests what this agent is for
 * rather than only saying "type something".
 */
function renderSuggestions() {
	const suggestions = [
		["现在几点？", "试一个无副作用的工具调用"],
		["介绍一下这个项目", "让 agent 读一遍仓库"],
		["帮我审查一段代码", "配合「代码审查」专家"],
		["调研一个问题", "配合「调研」专家，区分事实与推测"],
	];

	byId("empty-suggestions").replaceChildren(
		...suggestions.map(([title, hint]) => {
			const button = element("button");
			button.type = "button";
			button.append(element("b", null, title), element("small", null, hint));
			button.addEventListener("click", () => {
				input.value = title;
				autoGrow();
				input.focus();
			});
			return button;
		}),
	);
}

// -------------------------------------------------------------------- boot

async function boot() {
	if (!window.gdou) {
		addError("preload 未加载，渲染进程无法访问内核");
		return;
	}

	window.gdou.onEvent(handleEvent);
	window.gdou.onSession(applySession);

	wireWindowControls();
	wireNavToggle();
	wireSidebarResizer();
	wireMenuBar();
	wireInspectorDivider();
	setInspectorVisible(true);

	// The active turn dot tracks scroll, so it has to follow the reader. Passive
	// so it never competes with the browser's own scrolling.
	stream.addEventListener("scroll", updateTurnActive, { passive: true });

	let profiles;
	try {
		profiles = await window.gdou.profiles();
	} catch (error) {
		addError(`无法读取模式列表：${error.message}`);
		return;
	}

	byId("profile").replaceChildren(...profiles.map((profile) => new Option(profile.id, profile.id)));
	renderModeSwitch(profiles);
	renderSuggestions();

	// Experts are optional, so failing to read them must not stop the window from
	// opening — the mode alone is a usable session. The failure is reported and
	// boot continues.
	let catalog = { experts: [], errors: [] };
	try {
		catalog = await window.gdou.experts();
	} catch (error) {
		addError(`无法读取专家列表：${error.message}`);
	}

	// The empty value is "no expert". It has to be a real option rather than a
	// placeholder, because a user with a default expert needs a way to run
	// without one.
	byId("expert").replaceChildren(
		new Option("无专家", ""),
		...catalog.experts.map((expert) => new Option(expert.id, expert.id)),
	);
	state.expertCatalog = catalog;
	renderExperts(byId("experts"), catalog);
	renderExpertPaths();

	// Start on the first mode so the window is usable immediately rather than
	// waiting for a choice that most runs will not change. The expert is left
	// undefined on purpose: the main process then applies the stored default, and
	// the picker is synced to whatever it resolved to.
	//
	// A fresh conversation, not the most recent one. Opening the app straight
	// into an old transcript front-loads history the user did not ask for; the
	// history is one click away in the sidebar, and a new conversation is the
	// default most launches expect.
	const initial = profiles[0]?.id;
	if (initial) await startSession(initial, undefined, { fresh: true });
}

void boot();
