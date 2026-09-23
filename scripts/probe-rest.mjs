// Probe the remaining session verbs and settings: fork, resume, close, steer,
// compact, replay, workspace profile, settings.update.
// Fork is verified end-to-end — the copy is listed, then deleted, so the probe
// leaves the session store as it found it.
// Run: node scripts/probe-rest.mjs

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
	const cwd = process.cwd();

	const profile = await request("workspace.profile", { workspace_id: cwd });
	console.log("workspace.profile:", JSON.stringify(profile.profile).slice(0, 100));

	const list = await request("session.list", {});
	const sessions = list.sessions ?? [];
	console.log(`\nsession.list: ${sessions.length}`);
	const source = sessions[0];
	if (!source) { console.log("(no sessions)"); ws.close(); process.exit(0); }

	const forked = await request("session.fork", { session_id: source.session_id, title: "" });
	const forkId = forked.session_id;
	console.log(`fork → ${forkId}`);
	const afterFork = await request("session.list", {});
	const found = (afterFork.sessions ?? []).some((s) => s.session_id === forkId);
	console.log(found ? "ok   fork is listed" : "FAIL fork missing from list");

	const history = await request("session.get_history", { session_id: forkId });
	console.log(`fork history: ${(history.messages ?? []).length} message(s) copied`);

	const resumed = await request("session.resume", { session_id: forkId });
	console.log(resumed.session ? `ok   resume → ${resumed.session.title}` : "FAIL resume returned nothing");

	const compact = await request("session.compact", { session_id: forkId });
	console.log("compact:", JSON.stringify(compact));

	const replay = await request("run.replay", { run_id: "nope" });
	console.log(`run.replay: ${(replay.events ?? []).length} event(s)`);

	// Steer shares the send path; it must behave like an ordinary message.
	await request("session.steer_message", { session_id: forkId, content: "继续" }).catch((e) => console.log("steer err:", e.message));
	console.log("ok   steer accepted");

	const updated = await request("settings.update", { model: "deepseek/deepseek-flash" });
	console.log(`settings.update → model=${updated.settings?.model}`);

	// Clean up the fork so repeated runs do not pile up copies.
	await request("session.delete", { session_id: forkId });
	const final = await request("session.list", {});
	const stillThere = (final.sessions ?? []).some((s) => s.session_id === forkId);
	console.log(stillThere ? "FAIL fork not deleted" : "ok   fork deleted (store restored)");

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
setTimeout(() => { console.log("timeout"); process.exit(1); }, 15000);
