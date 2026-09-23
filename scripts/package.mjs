/**
 * Run electron-builder through a binaries mirror.
 *
 * electron-builder fetches two different things at build time, and both default
 * to GitHub:
 *
 *   1. Electron itself plus its `SHASUMS256.txt`, through `@electron/get`.
 *   2. Its own toolchain — winCodeSign, nsis — from electron-builder-binaries.
 *
 * Where GitHub is unreachable, the build dies with a bare `502 Bad Gateway`
 * after printing `downloaded label=electron progress=100%`. That ordering is
 * misleading: it reads as though Electron downloaded and something later broke.
 * What actually happens is that the Electron zip came from the local cache, and
 * the request that failed was the *checksum file* — a small text download that
 * the cache cannot satisfy.
 *
 * The fix is to point both at a mirror. This wrapper only supplies defaults, so
 * an explicit environment variable still wins and a different mirror (or none)
 * can be chosen per run.
 *
 * Integrity is unaffected: `@electron/get` still verifies the zip against the
 * mirror's `SHASUMS256.txt`, and electron-builder checks its own toolchain
 * against the checksums baked into its source.
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
	// Electron releases, including the checksum file.
	ELECTRON_MIRROR: "https://npmmirror.com/mirrors/electron/",
	// electron-builder's own toolchain.
	ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

const env = { ...process.env };
for (const [name, value] of Object.entries(DEFAULTS)) {
	if (!env[name]) env[name] = value;
}

const cli = join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js");
const args = [cli, "--config", "electron-builder.yml", ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: "inherit" });
child.on("exit", (code, signal) => {
	process.exit(signal ? 1 : (code ?? 1));
});
