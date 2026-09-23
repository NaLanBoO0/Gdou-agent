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
 * The shell — titlebar, sidebar, inspector — is SztuCode's, because the two
 * apps are meant to read as one product. The DOM contract is not: `check:gui`
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

function renderInline(text) {
	return escapeHtml(text)
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
		.replace(/\n/g, "<br>");
}

function renderParagraphs(text) {
	return text
		.split(/\n{2,}/)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => `<p>${renderInline(chunk)}</p>`)
		.join("");
}

/**
 * Render the subset of markdown the model actually produces often: fenced code
 * blocks, inline code, and bold. A full parser is more surface than this screen
 * needs; anything it cannot handle still reads fine as plain text.
 *
 * Code blocks are split out before any inline rule runs, so nothing rewrites
 * their contents, and they are emitted as siblings of paragraphs rather than
 * nested inside them.
 */
function renderMarkdown(text) {
	const segments = [];
	const fenced = /```[^\n]*\n([\s\S]*?)```/g;
	let cursor = 0;
	let match = fenced.exec(text);

	while (match !== null) {
		if (match.index > cursor) segments.push({ code: false, value: text.slice(cursor, match.index) });
		segments.push({ code: true, value: match[1].replace(/\n$/, "") });
		cursor = match.index + match[0].length;
		match = fenced.exec(text);
	}
	if (cursor < text.length) segments.push({ code: false, value: text.slice(cursor) });

	return segments
		.map((segment) => (segment.code ? `<pre><code>${escapeHtml(segment.value)}</code></pre>` : renderParagraphs(segment.value)))
		.join("");
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
	inspectorVisible: true,
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

function clearTranscript() {
	for (const node of [...transcriptEl.children]) {
		if (node.id !== "empty") node.remove();
	}
	state.assistant = null;
	state.tools.clear();
	setEmptyVisible(true);
}

function addUserMessage(text) {
	const wrapper = element("div", "msg msg-user");
	wrapper.append(element("div", "body", text));
	append(wrapper);
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
	const body = element("div", "body");
	wrapper.append(body);
	append(wrapper);
	state.assistant = body;
}

function addThinking(text) {
	const wrapper = element("div", "msg msg-assistant");
	wrapper.append(element("div", "thinking", text));
	append(wrapper);
}

function startTool(event) {
	const wrapper = element("div", "msg");
	const block = element("div", "tool");
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
	append(wrapper);

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

		card.addEventListener("click", () => openArtifact(item));
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
	state.tools.delete(event.id);
}

// ------------------------------------------------------------- event routing

function handleEvent(event) {
	switch (event.type) {
		case "run_start":
			state.running = true;
			setRunning(true);
			return;

		// Live runs never emit this — `send()` adds the bubble itself so the
		// message is visible even if the run fails to start. It arrives only
		// when a stored conversation is replayed.
		case "user_message":
			addUserMessage(event.text);
			return;

		case "assistant_start":
			beginAssistant();
			return;

		case "text_delta":
			if (!state.assistant) beginAssistant();
			state.assistant.textContent += event.text;
			autoScroll();
			return;

		case "thinking_delta":
			addThinking(event.text);
			return;

		case "assistant_end":
			// Re-render now that the message is complete and markdown is safe
			// to parse.
			if (state.assistant) state.assistant.innerHTML = renderMarkdown(state.assistant.textContent ?? "");
			state.assistant = null;
			autoScroll();
			return;

		case "tool_start":
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
		renderInspector();
		return;
	}

	const mode = session.scripted ? " · 脚本化运行" : "";
	const expert = session.expert ? ` · ${session.expert.label}` : "";

	// Shown only once the model stops seeing everything. An indicator that is
	// always present becomes furniture, and furniture stops being read — so it
	// stays out of the way until it has something to say.
	const context = state.context;
	const pruned = context && context.visible < context.total ? ` · 模型可见 ${context.visible}/${context.total} 条` : "";

	text.textContent = `${session.profile.id}${expert} · ${session.model.provider}/${session.model.id} · ${session.toolCount} 个工具${mode}${pruned}`;
	cwd.textContent = session.cwd;
	cwd.disabled = false;

	byId("footer-model").textContent = `${session.model.provider}/${session.model.id}`;
	byId("footer-cwd").textContent = session.cwd;
	byId("model-label").textContent = `${session.model.provider}/${session.model.id}${session.scripted ? "（脚本化）" : ""}`;
	byId("model-dot").className = session.scripted ? "online" : "";

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
	void startSession(event.target.value, state.expertId);
});

byId("expert").addEventListener("change", (event) => {
	if (state.running || !state.profileId) return;
	// The empty option is "no expert", which has to be sent as null rather than
	// omitted — omitting it would let the stored default come back.
	void startSession(state.profileId, event.target.value === "" ? null : event.target.value);
});

function beginNewChat() {
	// Starting over mid-run would discard the run's output as it arrives.
	if (state.running || !state.profileId) return;
	void startSession(state.profileId, state.expertId, { fresh: true });
}

byId("new-chat").addEventListener("click", beginNewChat);
byId("new-chat-inline").addEventListener("click", beginNewChat);

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
	inner.append(element("b", null, item.name));

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
				inner.append(element("span", null, `文件 ${formatSize(data.size)}，超过面板预览上限，请直接打开它。`));
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
			row.addEventListener("click", () => void openArtifact(item));
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

const VIEWS = ["chat", "experts", "automation", "skills"];

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
	if (view === "diagnostics") void loadDiagnostics();
}

for (const button of byId("primary-nav").querySelectorAll("button")) {
	button.addEventListener("click", () => setView(button.dataset.view));
}

// ------------------------------------------------------------------ experts

/** The mode switch mirrors the picker, so the two cannot disagree. */
function syncModeSwitch() {
	for (const button of byId("mode-switch").querySelectorAll("button")) {
		button.classList.toggle("active", button.dataset.mode === state.profileId);
	}
}

function renderModeSwitch(profiles) {
	byId("mode-switch").replaceChildren(
		...profiles.slice(0, 2).map((profile) => {
			const button = element("button", null, profile.label);
			button.type = "button";
			button.dataset.mode = profile.id;
			button.title = profile.description;
			button.addEventListener("click", () => {
				if (state.running || profile.id === state.profileId) return;
				void startSession(profile.id, state.expertId);
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

/** Reflect the running recipe in the two pickers. */
function syncPickers() {
	byId("profile").value = state.profileId ?? "";
	byId("expert").value = state.expertId ?? "";
}

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
			"GDOU agent — 基于 pi 内核的自定义 agent。内核跑在 Electron 主进程内，渲染进程零构建；模式决定能做什么，专家决定该怎么想。",
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
	const index = ["1", "2", "3", "4"].indexOf(key);
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
	wireMenuBar();
	wireInspectorDivider();
	setInspectorVisible(true);

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
	const initial = profiles[0]?.id;
	if (initial) await startSession(initial, undefined);
}

void boot();
