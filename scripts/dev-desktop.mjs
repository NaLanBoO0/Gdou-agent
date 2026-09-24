/**
 * Desktop dev/build orchestration for the Tauri shell.
 *
 * Tauri invokes this from the `shell/src-tauri` directory (`beforeDevCommand`
 * / `beforeBuildCommand`), so everything is resolved from this file's own
 * location rather than from `cwd`, keeping it robust to where Tauri happens to
 * run it.
 *
 * Two modes, mirroring the two Tauri commands:
 *
 *   --dev-server     Dev: ensure the bridge is bundled, then start the Vite dev
 *                    server (long-running). The Rust `daemon_start` command
 *                    spawns the bridge itself on the first front-end connect.
 *   --build-assets   Release: build the bridge to a single CJS file and build
 *                    the front-end, so `frontendDist` has real assets.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const SHELL = join(ROOT, "shell");
const BRIDGE_CJS = join(ROOT, "dist", "bridge.cjs");

function run(label, cmd, args, cwd) {
  return new Promise((resolve_) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: true });
    child.on("exit", (code) => {
      if (code === 0) resolve_();
      else { console.error(`[${label}] exited with ${code}`); process.exitCode = code; }
    });
  });
}

/** Bundle the bridge into dist/bridge.cjs. */
async function buildBridge() {
  await run("bridge", "node", ["scripts/build-bridge.mjs"], ROOT);
}

async function devServer() {
  // The Rust shell spawns dist/bridge.cjs; ensure it exists before the window
  // loads, or the first connect would fail to start the bridge.
  if (!existsSync(BRIDGE_CJS)) await buildBridge();
  // Long-running Vite dev server for http://127.0.0.1:5173.
  await run("vite", "npx", ["vite", "--port", "5173", "--host", "127.0.0.1"], SHELL);
}

async function buildAssets() {
  await buildBridge();
  await run("bridge-sea", "node", ["scripts/build-bridge-sea.mjs"], ROOT);
  await run("shell", "npx", ["vite", "build"], SHELL);
}

const mode = process.argv[2];
if (mode === "--dev-server") await devServer();
else if (mode === "--build-assets") await buildAssets();
else {
  console.error("usage: node scripts/dev-desktop.mjs --dev-server | --build-assets");
  process.exitCode = 1;
}