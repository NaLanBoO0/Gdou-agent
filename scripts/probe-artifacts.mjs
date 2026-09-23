// Probe the artifact / skill / model surface.
//
// Artifacts are verified end-to-end rather than by asserting on an empty list:
// this sends a real message so the scripted run performs a real `present_files`
// delivery, then checks the delivered file shows up in artifact.list.
// Run: node scripts/probe-artifacts.mjs

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
	const skills = await request("skill.list", { workspace_id: null });
	const list = skills.skills ?? [];
	console.log(`skill.list: ${list.length} skill(s): ${list.map((s) => s.id).join(", ")}`);

	const models = await request("provider.model_list");
	console.log(`provider.model_list: ${(models.models ?? []).length} model(s)`);
	for (const m of models.models ?? []) console.log(`  ${m.id} (current=${m.is_current})`);

	// Drive a real run so present_files actually fires.
	const created = await request("session.create", { mode: "chat" });
	const sessionId = created.session_id;
	console.log(`\nsending a message on ${sessionId} to trigger delivery...`);
	await request("session.send_message", { session_id: sessionId, content: "交付一个文件看看" });

	const artifacts = await request("artifact.list", { workspace_id: process.cwd() });
	const items = artifacts.artifacts ?? [];
	console.log(`\nartifact.list: ${items.length} artifact(s)`);
	for (const a of items) console.log(`  ${a.type}: ${a.path} (${a.size} bytes)`);
	console.log(items.length > 0 ? "ok   delivery captured" : "FAIL nothing captured");

	console.log(`\nevents seen: ${[...new Set(events)].join(", ")}`);
	ws.close();
	process.exit(0);
});

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString("utf8"));
	if (msg.jsonrpc && msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(msg.error.message));
		else resolve(msg.result ?? {});
	} else if (msg.kind === "event") {
		events.push(msg.event.type);
	}
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 12000);
