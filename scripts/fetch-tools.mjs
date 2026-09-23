/**
 * Fetches the binaries pi's coding tools shell out to.
 *
 * `grep` and `find` do not implement search themselves: they exec ripgrep and
 * fd. pi downloads both on first use, which means an installed app on a machine
 * without internet ends up with two silently broken tools — the user sees
 * "search returns nothing", not an error. Shipping them removes that failure
 * mode entirely, because pi checks its own bin directory before downloading.
 *
 * Versions are pinned here rather than resolved at build time, so a build is
 * reproducible and every binary in an installer has traceable provenance. Bump
 * them deliberately, then rerun.
 *
 * Both are permissively licensed and redistributable:
 *   ripgrep — MIT / Unlicense
 *   fd      — MIT / Apache-2.0
 *
 * Run with: npm run fetch:tools
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "vendor", "bin");

/**
 * Pinned versions, and the Windows x64 asset for each.
 *
 * The installer targets win32-x64, so that is what is fetched. Other platforms
 * would need their own asset names; add them here rather than guessing at
 * runtime, so an unsupported target fails loudly instead of shipping the wrong
 * binary.
 */
const TOOLS = {
	rg: {
		version: "15.0.0",
		binary: "rg.exe",
		label: "ripgrep",
		url: (version) =>
			`https://github.com/BurntSushi/ripgrep/releases/download/${version}/ripgrep-${version}-x86_64-pc-windows-msvc.zip`,
	},
	fd: {
		version: "10.5.0",
		binary: "fd.exe",
		label: "fd",
		url: (version) => `https://github.com/sharkdp/fd/releases/download/v${version}/fd-v${version}-x86_64-pc-windows-msvc.zip`,
	},
};

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

/**
 * Optional local directory to copy the binaries from instead of downloading.
 *
 * Downloading is the normal path. This exists for build hosts that cannot reach
 * GitHub — air-gapped machines, or the restrictive proxy this project is
 * sometimes built behind — and for reusing binaries a pi installation already
 * fetched. They are still verified against the pinned versions below, so this
 * cannot quietly ship a different build than a downloading one would.
 */
const LOCAL_SOURCE = process.env.GDOU_TOOLS_SOURCE;

/** Run a binary and return its combined output, or undefined if it cannot run. */
function run(binary, args) {
	const result = spawnSync(binary, args, { encoding: "utf-8" });
	if (result.error) return undefined;
	return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

/** Depth-first search for a file name inside an extracted archive. */
function findFile(root, name) {
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		} else if (entry === name) {
			return path;
		}
	}
	return undefined;
}

let curlChecked = false;
let curlPresent = false;

function hasCurl() {
	if (!curlChecked) {
		curlChecked = true;
		const result = spawnSync("curl", ["--version"], { stdio: "ignore" });
		curlPresent = !result.error && result.status === 0;
	}
	return curlPresent;
}

/**
 * Download, preferring curl.
 *
 * Node's built-in fetch deliberately ignores HTTP(S)_PROXY. This is a build
 * step that runs on developer machines, and on the machines this project is
 * built on GitHub is only reachable *through* a proxy, so fetch alone fails
 * with a bare "fetch failed" that says nothing about the cause. curl honours
 * those variables and ships with Windows 10 1803+ as well as mainstream Linux
 * and macOS, so it goes first and fetch stays as the fallback.
 */
async function download(url, destination) {
	if (hasCurl()) {
		const result = spawnSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "1", "-o", destination, url], {
			encoding: "utf-8",
		});
		if (result.error) throw new Error(`curl could not run: ${result.error.message}`);
		if (result.status !== 0) {
			throw new Error(`curl exited ${result.status}: ${(result.stderr ?? "").trim() || "no output"}`);
		}
		return;
	}

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

/**
 * Extract with `tar`, which is bsdtar on Windows 10+ and reads zip as well as
 * tar. pi takes the same approach, so this is not a new dependency.
 */
function extract(archive, destination) {
	const result = spawnSync("tar", ["-xf", archive, "-C", destination], { encoding: "utf-8" });
	if (result.error) throw new Error(`could not run tar: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`);
}

async function fetchTool(key, tool) {
	const destination = join(DEST, tool.binary);

	// Already fetched and runnable: leave it alone so repeat runs are cheap.
	if (existsSync(destination)) {
		const version = run(destination, ["--version"]);
		if (version?.includes(tool.version)) {
			process.stdout.write(`  ${key}      ${tool.version} (already present)\n`);
			return;
		}
		process.stdout.write(`  ${key}      replacing (version mismatch)\n`);
	}

	const work = await mkdtemp(join(tmpdir(), `gdou-${key}-`));
	try {
		let binary;

		if (LOCAL_SOURCE) {
			const source = join(resolve(LOCAL_SOURCE), tool.binary);
			if (!existsSync(source)) throw new Error(`${source} does not exist`);
			binary = source;
		} else {
			const archive = join(work, "archive.zip");
			await download(tool.url(tool.version), archive);

			const extracted = join(work, "extracted");
			mkdirSync(extracted);
			extract(archive, extracted);

			binary = findFile(extracted, tool.binary);
			if (!binary) throw new Error(`${tool.binary} not found inside the archive`);
		}

		mkdirSync(DEST, { recursive: true });
		copyFileSync(binary, destination);

		const version = run(destination, ["--version"]);
		if (!version) throw new Error(`${tool.binary} was copied but does not run`);
		if (!version.includes(tool.version)) {
			throw new Error(`${tool.binary} reports an unexpected version: ${version.split("\n")[0]}`);
		}
		const origin = LOCAL_SOURCE ? `from ${LOCAL_SOURCE}` : "downloaded";
		process.stdout.write(`  ${key}      ${version.split("\n")[0]} (${origin})\n`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function main() {
	if (process.platform !== "win32" || process.arch !== "x64") {
		fail(`Only win32-x64 assets are pinned. Current target: ${process.platform}-${process.arch}`);
	}

	process.stdout.write("fetching managed binaries\n");
	for (const [key, tool] of Object.entries(TOOLS)) {
		try {
			await fetchTool(key, tool);
		} catch (error) {
			fail(`  ${key}      FAILED: ${error.message}`);
		}
	}
	process.stdout.write(`into ${DEST}\n`);
}

await main();
