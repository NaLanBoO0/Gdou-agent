/**
 * Build script.
 *
 * The development setup links pi's TypeScript sources through tsconfig `paths`
 * and compiles them on the fly with tsx. That works locally but cannot ship: an
 * installed app has neither pi's checkout nor tsx. This script turns the same
 * sources into plain JavaScript that runs on its own.
 *
 * Three outputs, all CommonJS:
 *
 *   dist/main.cjs    Electron main process, with the pi kernel inlined.
 *   dist/preload.cjs The context bridge.
 *   dist/cli.cjs     Headless entry point, kept so the bundle can be exercised
 *                    without launching a window.
 *
 * Why CommonJS rather than ESM:
 *
 *   Electron hands the `electron` module to the ESM loader as CommonJS and
 *   synthesises its named exports by static analysis. Inside a bundle this
 *   synthesis is unreliable — `import { BrowserWindow } from "electron"` failed
 *   at link time with "does not provide an export named 'BrowserWindow'", and
 *   whether it failed depended on what else happened to be in the bundle. A
 *   default import fared no better: it resolved to an object without `app` on
 *   it. `require("electron")` involves no interop at all and always works, so
 *   the whole build standardises on CommonJS.
 *
 *   The preload script has to be CommonJS regardless: Electron only loads an
 *   ESM preload when the sandbox is disabled, and disabling the sandbox is a
 *   real security downgrade.
 *
 * One thing CommonJS does not provide is `import.meta`, and both this project
 * (`src/paths.ts`) and pi (`config.ts`, `native-platform.ts`) call
 * `fileURLToPath(import.meta.url)` at module scope. esbuild would otherwise
 * compile that to `undefined` and the module would throw on load, so
 * `import.meta.url` is redefined to a real file URL computed from `__filename`.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist");

/** Restores `import.meta.url`, which esbuild empties for CommonJS output. */
const META_BANNER = 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;';

const shared = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "cjs",
	tsconfig: join(ROOT, "tsconfig.json"),
	sourcemap: true,
	logLevel: "warning",
	// Provided by Electron at runtime. Bundling it would produce a file that
	// cannot resolve the Electron API.
	external: ["electron"],
	define: {
		// Lets `src/paths.ts` tell a bundled run from a tsx run.
		__GDOU_BUNDLED__: "true",
	},
};

/**
 * `import.meta.url` has to be restored for the Node-side entries, which call
 * `fileURLToPath(import.meta.url)` at module scope.
 *
 * The preload must not get this. It runs in a sandboxed renderer, where
 * `require` is a restricted shim: `node:url` is not among the modules it can
 * load, so the banner would throw on the first line and the preload would
 * silently never run — leaving `window.gdou` undefined with no error anywhere.
 * The preload does not use `import.meta` anyway.
 */
const nodeSide = {
	define: { ...shared.define, "import.meta.url": "__importMetaUrl" },
	banner: { js: META_BANNER },
};

async function sizeOf(path) {
	const info = await stat(path);
	return `${(info.size / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
	const started = Date.now();

	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });

	const entries = [
		["electron/main.ts", "main.cjs", nodeSide],
		["electron/preload.ts", "preload.cjs", {}],
		["src/cli.ts", "cli.cjs", nodeSide],
	];

	for (const [entry, output, extras] of entries) {
		await build({
			...shared,
			...extras,
			entryPoints: [join(ROOT, entry)],
			outfile: join(OUT, output),
		});
	}

	// The renderer is plain HTML/CSS/JS with no imports, so it is copied rather
	// than bundled. It will earn a bundler when it grows real components.
	await cp(join(ROOT, "renderer"), join(OUT, "renderer"), { recursive: true });

	const elapsed = Date.now() - started;
	process.stdout.write(`built in ${elapsed} ms\n`);
	for (const [, output] of entries) {
		process.stdout.write(`  dist/${output.padEnd(13)} ${await sizeOf(join(OUT, output))}\n`);
	}
	process.stdout.write(`  dist/renderer/    copied\n`);
}

await main();
