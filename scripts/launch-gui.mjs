/**
 * Launch the desktop app.
 *
 * Exists as a script rather than as a plain `electron .` in package.json
 * because two environment variables have to be removed first, and npm scripts
 * have no portable way to do that.
 *
 * Both are the same class of leak. An Electron-based host — an editor such as
 * VS Code, or this project's own agent harness — exports them, every terminal
 * opened inside that host inherits them, and Electron then refuses to start as
 * Electron:
 *
 *   ELECTRON_RUN_AS_NODE=1  electron.exe runs as a plain Node process instead
 *                           of the app.
 *   NODE_OPTIONS            a `--require` hook there runs before the entry
 *                           point and can shadow the `electron` module.
 *
 * In both cases `require("electron")` resolves to the npm package, whose export
 * is the *path to the binary* rather than the API, so `app` is undefined and
 * startup dies on `app.isPackaged`. The message that reaches the user is
 * `Cannot read properties of undefined (reading 'isPackaged')` from somewhere
 * inside `dist/main.cjs` — which points at our code for something the
 * environment did, so it is fixed here rather than documented.
 *
 * `scripts/gui-check.mjs` does the same thing for the same reason. That check
 * would otherwise fail on the machine of anyone running it from such a host,
 * which is a confusing way to learn about a variable you never set.
 *
 * Deleting the keys is the part that matters: an empty string still counts as
 * set and reproduces the failure exactly, so the fix would look like it does
 * not work.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The `electron` package exports the path to its binary, which is exactly what
// a launcher needs — and it resolves the same way on Windows and elsewhere.
const ELECTRON_BINARY = require("electron");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.NODE_OPTIONS;

	// `stdio: "inherit"` rather than piping: the app's own output is the only
	// useful thing on the terminal, and buffering it would hide a crash until
	// the window failed to appear.
	const child = spawn(ELECTRON_BINARY, [".", ...process.argv.slice(2)], {
		cwd: ROOT,
		env,
		stdio: "inherit",
	});

	child.on("error", (error) => {
		process.stderr.write(`could not start Electron: ${error.message}\n`);
		process.exit(1);
	});

	child.on("close", (code, signal) => {
		// A signal is reported by re-raising it, so a shell that inspects
		// `$?` — or a wrapper running this in a pipeline — sees the app was
		// killed rather than that it exited cleanly with an odd code.
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 0);
	});
}

main();
