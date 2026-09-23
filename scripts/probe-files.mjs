// Probe the file / git read-only surface: inspector tree, file view, and the
// source-control panel. Verified against the real working directory, so a
// mapping bug shows up as an empty panel rather than as a green assertion on
// invented data.
// Run: node scripts/probe-files.mjs

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

	const tree = await request("workspace.tree", { workspace_id: cwd, path: "", max_depth: 1 });
	const nodes = tree.nodes ?? [];
	console.log(`workspace.tree: ${nodes.length} node(s)`);
	for (const n of nodes.slice(0, 8)) console.log(`  ${n.kind === "directory" ? "d" : "f"} ${n.name}`);
	console.log(nodes.length > 0 ? "ok   tree non-empty" : "FAIL tree empty");

	const read = await request("file.read", { workspace_id: cwd, path: "package.json" });
	const content = String(read.content ?? "");
	console.log(`file.read package.json: ${content.length} chars`);
	console.log(content.includes("gdou-agent") ? "ok   read returned real content" : "FAIL read content wrong");

	const status = await request("workspace.status", { workspace_id: cwd });
	console.log("workspace.status:", JSON.stringify(status).slice(0, 120));

	const changes = await request("change.list", { workspace_id: cwd });
	console.log(`change.list: ${(changes.changes ?? []).length} changed file(s)`);

	const history = await request("git.history", { workspace_id: cwd, limit: 20 });
	const commits = history.commits ?? [];
	console.log(`git.history: ${commits.length} commit(s)`);
	if (commits[0]) console.log(`  latest: ${String(commits[0].subject).slice(0, 60)}`);

	// The mutating verbs must stay unimplemented until there is an approval step.
	for (const m of ["git.commit", "change.discard", "change.revert"]) {
		const r = await request(m, { workspace_id: cwd }).catch((e) => ({ refusal: e.message }));
		console.log(r.refusal ? `ok   ${m} refused: ${r.refusal.slice(0, 60)}` : `FAIL ${m} unexpectedly succeeded`);
	}

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
setTimeout(() => { console.log("timeout"); process.exit(1); }, 10000);
