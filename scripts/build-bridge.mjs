/**
 * Build the bridge as a single CommonJS file.
 *
 * The bridge (`bridge/server.ts`) is the pi kernel exposed as a JSON-RPC service
 * over WebSocket. In development it runs under tsx (`npm run bridge`); a Tauri
 * shell needs it as one plain file it can spawn with `node`, without tsx or pi's
 * checkout present.
 *
 * This mirrors the Node-side entries in `scripts/build.mjs`: bundle everything
 * (pi kernel inlined) to CommonJS, restore `import.meta.url` via a banner, and
 * mark `__GDOU_BUNDLED__` so `src/paths.ts` can tell a bundled run from a tsx
 * run. Unlike `build.mjs` it only writes `dist/bridge.cjs` and does not clear
 * the rest of `dist/`, so a front-end build in the same output directory is not
 * disturbed.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");

const META_BANNER = 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;';

async function sizeOf(path) {
	const info = await stat(path);
	return `${(info.size / 1024 / 1024).toFixed(1)} MB`;
}

const started = Date.now();
await mkdir(OUT, { recursive: true });
await build({
	bundle: true,
	platform: "node",
	target: "node22",
	format: "cjs",
	tsconfig: join(ROOT, "tsconfig.json"),
	sourcemap: true,
	logLevel: "warning",
	external: ["electron"],
	define: {
		__GDOU_BUNDLED__: "true",
		"import.meta.url": "__importMetaUrl",
	},
	banner: { js: META_BANNER },
	entryPoints: [join(ROOT, "bridge/server.ts")],
	outfile: join(OUT, "bridge.cjs"),
});

process.stdout.write(`built dist/bridge.cjs in ${Date.now() - started} ms (${await sizeOf(join(OUT, "bridge.cjs"))})\n`);