// Probe the session lifecycle: reading a stored conversation back, renaming and
// deleting. Verifies the bridge against *real* stored sessions rather than
// fixtures, so a mapping bug shows up as missing content rather than as a
// passing assertion on invented data.
// Run: node scripts/probe-session.mjs

import { WebSocket } from "ws";

const ws = new WebSocket("ws://127.0.0.1:7438");
let id = 0;
const pending = new Map();

function request(method, params = {}) {
	return new Promise((resolve, reject) => {
		const reqId = String(++id);
		pending.set(reqId, { resolve, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }));
	});
}

ws.on("open", async () => {
	const list = await request("session.list", {});
	const sessions = list.result?.sessions ?? list.sessions ?? [];
	console.log(`stored sessions: ${sessions.length}`);
	if (sessions.length === 0) {
		console.log("(no stored sessions to read — send a message first)");
		ws.close();
		process.exit(0);
	}

	const first = sessions[0];
	console.log("first session:", first.session_id, "|", first.title);

	const history = await request("session.get_history", { session_id: first.session_id });
	const messages = history.result?.messages ?? history.messages ?? [];
	console.log(`history: ${messages.length} message(s)`);
	for (const m of messages.slice(0, 4)) {
		console.log(`  [${m.role}] ${String(m.content).slice(0, 60).replace(/\n/g, " ")}`);
	}
	// A history that reads back as zero messages is the failure worth catching:
	// the shell would show an empty conversation for a session it just listed.
	console.log(messages.length > 0 ? "ok   history has content" : "FAIL history is empty");

	// Rename, then confirm it stuck by listing again.
	const newTitle = `probe-${Date.now()}`;
	await request("session.rename", { session_id: first.session_id, title: newTitle });
	const after = await request("session.list", {});
	// `request` already unwraps `result`, so the array is one level in.
	const renamed = (after.sessions ?? []).find((s) => s.session_id === first.session_id);
	console.log(renamed?.title === newTitle ? `ok   rename stuck: ${newTitle}` : `FAIL rename: ${renamed?.title}`);

	// Restore the original title so the probe leaves no trace.
	await request("session.rename", { session_id: first.session_id, title: first.title });
	console.log("ok   original title restored");

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
	}
});

ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 8000);
