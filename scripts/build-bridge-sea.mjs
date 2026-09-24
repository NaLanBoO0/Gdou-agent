/**
 * Build a self-contained `bridge.exe` from the bundled `dist/bridge.cjs` using
 * Node's Single Executable Application (SEA) support.
 *
 * The Tauri shell spawns the bridge as a child process. A plain `node` runtime
 * exists here, but a friend's machine that installs the NSIS package won't have
 * Node. SEA inlines the bridge script into a copy of the Node binary, so the
 * package only needs `bridge.exe` — no Node install required.
 *
 * Steps:
 *  1. write a sea-config.json describing the entry + blob output
 *  2. `node --experimental-sea-config` -> bridge.blob
 *  3. copy the current Node executable to bridge.exe
 *  4. inject the blob with postject
 *  5. drop the finished bridge.exe into shell/src-tauri/resources/ so Tauri
 *     bundles it as an install resource, alongside the app exe.
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DIST = join(ROOT, "dist");
const SEA_CONFIG = join(ROOT, "dist", "sea-config.json");
const BLOB = join(ROOT, "dist", "bridge.blob");
const EXE = join(ROOT, "dist", "bridge.exe");
const RESOURCE_EXE = join(ROOT, "shell", "src-tauri", "resources", "bridge.exe");

function run(exe, args) {
  return new Promise((resolve_, reject) => {
    // Build a single, individually-quoted command line and hand it to the shell
    // as the command itself. Passing a separated `args` array with `shell:true`
    // triggers Node's DEP0190 (concatenation, not escaping).
    const quote = (s) => /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
    const cmdline = [quote(exe), ...args.map(quote)].join(" ");
    const child = spawn(cmdline, { cwd: ROOT, shell: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve_() : reject(new Error(`[${exe}] exited ${code}\n${out}`))));
  });
}

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const started = Date.now();

await mkdir(DIST, { recursive: true });
await mkdir(dirname(RESOURCE_EXE), { recursive: true });

// 1. SEA config with absolute paths so node resolves them regardless of cwd.
await writeFile(
  SEA_CONFIG,
  JSON.stringify(
    {
      main: join(DIST, "bridge.cjs"),
      output: BLOB,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

// 2. Generate the code blob.
await run(process.execPath, ["--experimental-sea-config", SEA_CONFIG], ROOT);

// 3. Copy the Node binary as the payload host.
await copyFile(process.execPath, EXE);

// 4. Inject the blob.
await run("npx", ["postject", EXE, "NODE_SEA_BLOB", BLOB, "--sentinel-fuse", FUSE], ROOT);

// 5. Stage for Tauri bundling.
await copyFile(EXE, RESOURCE_EXE);

process.stdout.write(`built bridge.exe in ${Date.now() - started} ms\n`);