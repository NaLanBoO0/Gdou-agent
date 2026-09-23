/**
 * Renderer check.
 *
 * Drives `dist/renderer/index.html` in a real browser over the DevTools
 * protocol, with `window.gdou` replaced by a stub, and asserts what the page
 * does. No Electron, so this is the check that still runs when `check:gui`
 * cannot — an Electron renderer that dies on this machine for reasons unrelated
 * to the code takes the whole suite with it, and the interface is then untested
 * exactly when it most needs testing.
 *
 * What it cannot cover: anything that depends on the real main process. The stub
 * answers like a well-behaved one, so this proves the page, not the wiring —
 * `check:gui` and `smoke` own that half.
 *
 * Run: npm run check:renderer
 */

// Temporary: drive the renderer in Edge with a stubbed bridge, no Electron.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PAGE = `file:///${ROOT.replace(/\\/g, "/")}/dist/renderer/index.html`;
/**
 * A Chromium to drive the page with.
 *
 * Overridable, and discovered rather than assumed: this check exists because it
 * does not need Electron, so hard-coding one vendor's path would give that up.
 */
function findBrowser() {
	const candidates = [
		process.env.GDOU_BROWSER,
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	].filter(Boolean);
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		throw new Error(`no Chromium found; set GDOU_BROWSER to one of: ${candidates.join(" | ")}`);
	}
	return found;
}

const BROWSER = findBrowser();
const KEY = "sk-web-fixture-0000cafe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
	return new Promise((res, rej) => {
		const s = createServer();
		s.on("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
}

// No backticks anywhere below, so this can be embedded in a JS string verbatim.
const STUB = [
	"(function () {",
	"  var rows = [",
	"    { providerId: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', models: [], defaultModel: 'deepseek-flash' },",
	"    { providerId: 'moonshotai', label: 'Moonshot / Kimi', envVar: 'MOONSHOT_API_KEY', models: [], defaultModel: 'kimi-k3' },",
	"    { providerId: 'zai', label: 'Zhipu GLM', envVar: 'ZAI_API_KEY', models: [], defaultModel: 'glm-5.3' },",
	"    { providerId: 'qwen-token-plan', label: 'Qwen', envVar: 'QWEN_TOKEN_PLAN_API_KEY', models: [], defaultModel: 'qwen3.8-max' },",
	"    { providerId: 'minimax', label: 'MiniMax', envVar: 'MINIMAX_API_KEY', models: [], defaultModel: 'MiniMax-M3' },",
	"  ];",
	"  var AUTHPATH = 'C:/fake/.gdou-agent/auth.json';",
	"  var MODELS = [",
	"    { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 128000, reasoning: false },",
	"    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 256000, reasoning: true },",
	"  ];",
	"  var sessionListener = null;",
	"  window.__lastKey = null;",
	"  window.__lastSpec = null;",
	"  window.__startCalls = [];",
	"  window.__errors = [];",
	"  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });",
	"  window.addEventListener('unhandledrejection', function (e) { window.__errors.push('rejection: ' + String(e.reason)); });",
	"  function snapshot() { return { providers: rows, authPath: AUTHPATH }; }",
	"  var api = {",
	"    credentials: function () { return Promise.resolve(snapshot()); },",
	"    models: function () { return Promise.resolve(MODELS); },",
	"    setCredential: function (id, key) {",
	"      window.__lastKey = key;",
	"      rows = rows.map(function (r) {",
	"        if (r.providerId !== id) return r;",
	"        return Object.assign({}, r, { source: 'stored', hint: '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022' + key.slice(-4) });",
	"      });",
	"      return Promise.resolve(snapshot());",
	"    },",
	"    removeCredential: function (id) {",
	"      rows = rows.map(function (r) {",
	"        if (r.providerId !== id) return r;",
	"        return { providerId: r.providerId, label: r.label, envVar: r.envVar, models: [], defaultModel: r.defaultModel };",
	"      });",
	"      return Promise.resolve(snapshot());",
	"    },",
	"    setModel: function (spec) { window.__lastSpec = spec; return Promise.resolve({}); },",
	"    start: function (profileId, expertId, scripted) {",
	"      window.__startCalls.push({ profileId: profileId, expertId: expertId, scripted: scripted });",
	"      var anyConfigured = rows.some(function (r) { return r.source; });",
	"      if (!anyConfigured) return Promise.reject(new Error('No model available: no provider has a credential.'));",
	"      var started = { info: {",
	"        profile: { id: profileId, label: profileId },",
	"        expert: null,",
	"        model: { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek Flash' },",
	"        fallback: null,",
	"        cwd: 'C:/fake/work',",
	"        toolCount: 5,",
	"        modelReady: anyConfigured,",
	"        scripted: scripted === true,",
	"        unavailableTools: [],",
	"      }, history: [] };",
	"      if (sessionListener) sessionListener(started);",
	"      return Promise.resolve(started);",
	"    },",
	"    profiles: function () { return Promise.resolve([",
	"      { id: 'general', label: 'General', description: 'daily', source: null },",
	"      { id: 'coding', label: 'Coding', description: 'repo', source: null },",
	"    ]); },",
	"    experts: function () { return Promise.resolve({ experts: [], errors: [], paths: [] }); },",
	"    listSessions: function () { return Promise.resolve([]); },",
	"    probe: function () { return Promise.resolve({}); },",
	"    onEvent: function () { return function () {}; },",
	"    onSession: function (fn) { sessionListener = fn; return function () {}; },",
	"    onWindowState: function () { return function () {}; },",
	"    window: { minimize: function () {}, toggleMaximize: function () {}, close: function () {} },",
	"  };",
	"  window.gdou = new Proxy(api, {",
	"    get: function (target, name) {",
	"      if (name in target) return target[name];",
	"      return function () { return Promise.resolve(undefined); };",
	"    },",
	"  });",
	"})();",
].join("\n");

function connect(wsUrl) {
	const socket = new WebSocket(wsUrl);
	const pending = new Map();
	let id = 1;
	socket.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		if (msg.error) entry.reject(new Error(msg.error.message));
		else entry.resolve(msg.result);
	});
	const ready = new Promise((res, rej) => {
		socket.addEventListener("open", () => res());
		socket.addEventListener("error", () => rej(new Error("attach failed")));
	});
	return {
		async send(method, params = {}) {
			await ready;
			const n = id++;
			return new Promise((res, rej) => {
				pending.set(n, { resolve: res, reject: rej });
				socket.send(JSON.stringify({ id: n, method, params }));
			});
		},
		async evaluate(expression) {
			const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "threw");
			return r?.result?.value;
		},
		close() {
			socket.close();
		},
	};
}

async function waitFor(client, expression, done, label) {
	const deadline = Date.now() + 15000;
	let last;
	while (Date.now() < deadline) {
		last = await client.evaluate(expression);
		if (done(last)) return last;
		await sleep(120);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

let passed = 0;
let failed = 0;
function report(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`  ok   ${label}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${label}${detail === undefined ? "" : `  [${detail}]`}`);
	}
}

const display = (id) => `getComputedStyle(document.getElementById("${id}")).display`;
const deepseekRow = `[].slice.call(document.querySelectorAll("#credential-list .cred-row")).filter(function (r) { return r.textContent.indexOf("DEEPSEEK_API_KEY") >= 0; })[0]`;

async function main() {
	const port = await freePort();
	const browser = spawn(
		BROWSER,
		["--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--disable-gpu", "about:blank"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	let page = null;
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline && !page) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			page = targets.find((t) => t.type === "page");
		} catch {}
		if (!page) await sleep(200);
	}
	if (!page) throw new Error("Edge never exposed a page target");

	const client = connect(page.webSocketDebuggerUrl);
	try {
		await client.send("Page.enable");
		await client.send("Runtime.enable");
		await client.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
		await client.send("Page.navigate", { url: PAGE });
		// Not readyState: about:blank is already "complete", so the first poll
		// would succeed against the page this one is replacing.
		await waitFor(client, "!!document.getElementById('model-menu')", (v) => v === true, "the app page");
		await sleep(500);

		console.log("\n第一步：什么都没点之前");
		report(
			"模型菜单初始不可见（这是修掉的那个 bug）",
			(await client.evaluate(display("model-menu"))) === "none",
			await client.evaluate(display("model-menu")),
		);
		report("设置页初始不可见", (await client.evaluate(display("view-settings"))) === "none");
		report("导航与页面对账", (await client.evaluate(
			`JSON.stringify([].slice.call(document.querySelectorAll("#primary-nav button")).map(function (b) { return b.dataset.view; }))`,
		)) === JSON.stringify(["chat", "experts", "automation", "skills", "settings"]));

		console.log("\n第二步：设置页填 key");
		await client.evaluate("document.querySelector('[data-view=settings]').click()");
		await waitFor(client, "document.querySelectorAll('#credential-list .cred-row').length", (n) => Number(n) >= 5, "the rows");
		report("设置页可见", (await client.evaluate(display("view-settings"))) !== "none");
		report("五个预设各一行", (await client.evaluate("document.querySelectorAll('#credential-list .cred-row').length")) >= 5);
		report("初始全部未配置", (await client.evaluate("document.querySelectorAll('#credential-list .status-pill--idle').length")) >= 5);
		report("初始没有可删的（环境变量来的 key 不该给删除按钮）",
			(await client.evaluate(`[].slice.call(document.querySelectorAll("#credential-list button.ghost")).every(function (b) { return b.disabled; })`)) === true);
		report("页面写出凭据文件路径",
			String(await client.evaluate(`document.getElementById("auth-path").textContent`)).endsWith("auth.json"));

		await client.evaluate(`(function () { var row = ${deepseekRow}; row.querySelector(".cred-input").value = "${KEY}"; row.querySelector("button.outline-button").click(); })()`);
		await waitFor(client, "document.querySelectorAll('#credential-list .status-pill:not(.status-pill--idle)').length", (n) => Number(n) >= 1, "the save to land");
		await sleep(300);

		const after = await client.evaluate(`(function () {
			var row = ${deepseekRow};
			return {
				status: row.querySelector(".status-pill").textContent,
				body: document.getElementById("view-settings").textContent,
				providers: [].slice.call(document.getElementById("model-provider").options).map(function (o) { return o.value; }),
				models: [].slice.call(document.getElementById("model-id").options).map(function (o) { return o.value; }),
				sentKey: window.__lastKey,
				startCalls: window.__startCalls
			};
		})()`);

		report("该行报告已配置", after.status.indexOf("已配置") >= 0, after.status);
		report("只显示掩码", after.status.indexOf("••••") >= 0, after.status);
		report("key 送到了桥（trim 后）", after.sentKey === KEY);
		report("页面里从不出现完整 key", after.body.indexOf(KEY) < 0);
		report("也不出现它的长片段", after.body.indexOf(KEY.slice(4, -4)) < 0);
		report("模型下拉列出了该服务商", after.providers.indexOf("deepseek") >= 0, after.providers.join(","));
		report("以及它的模型", after.models.indexOf("deepseek/deepseek-flash") >= 0, after.models.slice(0, 3).join(","));

		console.log("\n第三步：保存 key 之后有没有真的脱离脚本化");
		const started = after.startCalls[after.startCalls.length - 1];
		report("保存 key 触发了一次会话重建", after.startCalls.length >= 1, JSON.stringify(after.startCalls));
		report("并且显式传了 scripted: false", started && started.scripted === false, JSON.stringify(started));

		report("灰点变绿（模型可以调用）",
			(await client.evaluate(`document.getElementById("model-dot").className`)) === "online",
			await client.evaluate(`document.getElementById("model-dot").className`));
		report("标题说明了能不能调用",
			String(await client.evaluate(`document.getElementById("model-trigger").title`)).indexOf("可以调用") >= 0,
			await client.evaluate(`document.getElementById("model-trigger").title`));

		console.log("\n第四步：编写器里的模型菜单");
		await client.evaluate("document.querySelector('[data-view=chat]').click()");
		await client.evaluate("document.getElementById('model-trigger').click()");
		await waitFor(client, "document.querySelectorAll('#model-menu-list .model-menu-item').length", (n) => Number(n) > 0, "the menu to fill");

		const menu = await client.evaluate(`(function () {
			var el = document.getElementById("model-menu");
			return {
				visible: getComputedStyle(el).display !== "none",
				items: [].slice.call(document.querySelectorAll("#model-menu-list .model-menu-item")).length,
				current: document.querySelectorAll('#model-menu-list [aria-checked="true"]').length,
				note: document.getElementById("model-menu-note").textContent,
				expanded: document.getElementById("model-trigger").getAttribute("aria-expanded")
			};
		})()`);
		report("点击后菜单可见", menu.visible === true && menu.expanded === "true", String(menu.expanded));
		report("列出了模型", menu.items > 0, String(menu.items));
		report("恰好一个标记为当前", menu.current === 1, String(menu.current));
		report("页脚说明只列已配置的服务商", menu.note.indexOf("只列出已配置") >= 0, menu.note);

		await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
		report("Escape 能关掉", (await client.evaluate(display("model-menu"))) === "none");

		await client.evaluate("document.getElementById('model-trigger').click()");
		await sleep(250);
		await client.evaluate(`document.getElementById("stream").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
		report("点外面也能关掉", (await client.evaluate(display("model-menu"))) === "none");

		report("弹层挂在 body 上（不被编写器的 overflow 裁掉）",
			(await client.evaluate(`document.getElementById("model-menu").parentElement === document.body`)) === true);
		report("弹层用 fixed 定位",
			(await client.evaluate(`getComputedStyle(document.getElementById("model-menu")).position`)) === "fixed");
		report("弹层完整落在视口内",
			(await client.evaluate(`(function () { var r = document.getElementById("model-menu").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1; })()`)) === true);

		await client.evaluate("document.getElementById('model-trigger').click()");
		await waitFor(client, "document.querySelectorAll('#model-menu-list .model-menu-item').length", (n) => Number(n) > 1, "the menu again");
		await client.evaluate("document.querySelectorAll('#model-menu-list .model-menu-item')[1].click()");
		await sleep(250);
		report("点某一行真的会切换",
			(await client.evaluate("window.__lastSpec")) === "deepseek/deepseek-v4-pro",
			await client.evaluate("window.__lastSpec"));
		report("切换后菜单收起", (await client.evaluate(display("model-menu"))) === "none");

		console.log("\n第五步：删掉 key");
		await client.evaluate("document.querySelector('[data-view=settings]').click()");
		await waitFor(client, "document.querySelectorAll('#credential-list .cred-row').length", (n) => Number(n) >= 5, "the rows again");
		await client.evaluate(`(function () { var row = ${deepseekRow}; row.querySelector("button.ghost").click(); })()`);
		await waitFor(client, "document.querySelectorAll('#credential-list .status-pill:not(.status-pill--idle)').length", (n) => Number(n) === 0, "the remove to land");
		report("删掉后回到未配置", (await client.evaluate("document.querySelectorAll('#credential-list .status-pill--idle').length")) >= 5);

		const errors = await client.evaluate("JSON.stringify(window.__errors)");
		report("整个过程中页面没有报错", errors === "[]", errors);

		console.log(`\n${passed}/${passed + failed} passed`);
	} finally {
		client.close();
		spawn("taskkill", ["/pid", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
		await sleep(300);
	}
}

main().catch((error) => {
	console.log("ERROR:", error.message);
	process.exitCode = 1;
});
