// Probe the boot set: the methods refreshIndex() calls in parallel at startup.
// A single rejection there fails the whole Promise.all and the shell renders
// nothing, so these are verified separately from the conversation path.
// Run: node scripts/probe-boot.mjs

import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:7438");
let id = 0;
const pending = new Map();
const events = [];

function request(method, params = {}) {
	return new Promise((resolve, reject) => {
		const reqId = String(++id);
		pending.set(reqId, { resolve, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
	});
}

ws.on("open", async () => {
	// Mirrors refreshIndex(): these five run in parallel and all must resolve.
	const methods = [
		["workspace.list", {}],
		["session.list", { limit: 100, include_archived: true }],
		["settings.get", {}],
		["provider.status", {}],
		["question.pending", {}],
		["operation.list", {}],
	];
	const results = await Promise.all(methods.map(([m, p]) => request(m, p).catch((e) => ({ error: e.message, method: m }))));
	for (let i = 0; i < methods.length; i++) {
		const [m] = methods[i];
		const r = results[i];
		if (r.error) {
			console.log(`FAIL ${m}: ${r.error}`);
		} else {
			const payload = r.result ?? r;
			console.log(`ok   ${m}:`, JSON.stringify(payload).slice(0, 160));
		}
	}
	console.log("events seen:", events.length);
	ws.close();
	process.exit(0);
});

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString("utf8"));
	if (msg.jsonrpc && msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(msg.error.message));
		else resolve(msg);
	} else if (msg.kind === "event") {
		events.push(msg.event.type);
	}
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 8000);
