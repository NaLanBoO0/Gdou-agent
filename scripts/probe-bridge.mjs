// Manual probe for the bridge server: verifies the JSON-RPC handshake and a
// full scripted conversation round-trip without the shell front-end.
// Run: node scripts/probe-bridge.mjs

import { WebSocket } from "ws";

const url = "ws://127.0.0.1:7438";
const ws = new WebSocket(url);
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
	console.log("connected");
	try {
		const ping = await request("core.ping");
		console.log("ping →", JSON.stringify(ping));

		const created = await request("event.subscribe", { topics: ["session.*"], scope: "global" });
		console.log("subscribe →", JSON.stringify(created));

		const session = await request("session.create", { mode: "chat" });
		console.log("session.create →", JSON.stringify(session));

		const run = await request("session.send_message", { session_id: session.result.session_id, content: "hello" });
		console.log("session.send_message →", JSON.stringify(run));
	} catch (e) {
		console.error("request error:", e);
		ws.close();
	}
});

ws.on("message", (data) => {
	const msg = JSON.parse(data.toString("utf8"));
	if (msg.jsonrpc && msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) reject(new Error(msg.error.message));
		else resolve(msg);
	} else if (msg.kind === "event") {
		console.log("EVENT:", msg.event.type, msg.event.run_id ?? "", msg.event.token ?? msg.event.message ?? "");
	}
});

ws.on("error", (e) => console.error("ws error:", e.message));

setTimeout(() => { console.log("done"); ws.close(); process.exit(0); }, 6000);
