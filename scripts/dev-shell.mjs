/**
 * Start the bridge and the shell together.
 *
 * Stage 1 runs as two processes: the bridge (pi kernel as a JSON-RPC service on
 * 7438) and the shell (Vite dev server on 5173). Forgetting the first is easy —
 * and the symptom is unhelpful, because the shell reports "本地服务未连接"
 * rather than "you did not start the bridge". This launches both so the pair
 * cannot get out of step.
 *
 * Run: npm run dev:shell
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shell = join(root, "shell");

const children = [];

function run(label, command, args, cwd) {
	const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: true });
	const prefix = `[${label}] `;
	child.stdout.on("data", (data) => process.stdout.write(prefix + data.toString()));
	child.stderr.on("data", (data) => process.stderr.write(prefix + data.toString()));
	child.on("exit", (code) => {
		console.log(`${prefix}exited with ${code}`);
		shutdown(code ?? 0);
	});
	children.push(child);
	return child;
}

let shuttingDown = false;
function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		if (!child.killed) child.kill();
	}
	process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const BRIDGE_PORT = 7438;

/**
 * Is something already listening on the bridge port?
 *
 * Asked before spawning, because a bridge left running from an earlier session
 * is the common case rather than an error: it is fully usable, and starting a
 * second one only produces `EADDRINUSE`. Reusing it also keeps whatever
 * conversations were already live in that process.
 */
function bridgeAlreadyRunning() {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: BRIDGE_PORT });
		const done = (up) => {
			socket.destroy();
			resolve(up);
		};
		socket.setTimeout(700);
		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

bridgeAlreadyRunning().then((running) => {
	if (running) {
		console.log(`[dev] 检测到 ${BRIDGE_PORT} 已有桥在运行，直接复用（不重复启动）。`);
	} else {
		run(
			"bridge",
			"node",
			["--import", "./scripts/pi-env.mjs", "node_modules/tsx/dist/cli.mjs", "--tsconfig", "./tsconfig.json", "bridge/server.ts"],
			root,
		);
	}

	// Give a freshly spawned bridge a moment to bind before the shell connects —
	// a shell that connects first reports "本地服务未连接" and only recovers on its
	// own retry, which reads as a broken app even though nothing is wrong.
	setTimeout(() => {
		run("shell", "npx", ["vite", "--port", "5173"], shell);
	}, running ? 300 : 1500);
});

console.log(`[dev] bridge → ws://127.0.0.1:${BRIDGE_PORT}, shell → http://127.0.0.1:5173`);
console.log("[dev] Ctrl+C stops both.");
