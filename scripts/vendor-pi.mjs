/**
 * Vendor pi's source into this project, and record what was taken.
 *
 * The project used to resolve `@earendil-works/*` through tsconfig `paths` into
 * a sibling pi checkout. That works for development but makes the project
 * unbuildable on any machine without that checkout — which is not what a
 * standalone project should require. This copies the dependency closure in.
 *
 * Copying and recording are one step on purpose. The manifest it writes is what
 * makes "we have not modified pi" checkable rather than merely claimed, and it
 * means an upstream upgrade shows up as an explicit, reviewable diff instead of
 * being buried inside some unrelated change.
 *
 * Run with: npm run vendor:pi -- --from <path to a pi checkout>
 *
 * There is no default path — the script refuses to guess where pi lives. This
 * keeps the project from implicitly depending on a sibling directory.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PACKAGES } from "./pi-packages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "vendor", "pi");

const PACKAGES = PI_PACKAGES;

function parseArgs(argv) {
	const index = argv.indexOf("--from");
	if (index === -1) {
		throw new Error(
			"Usage: npm run vendor:pi -- --from <path to a pi checkout>\n" +
			"No default is assumed — the project does not depend on a sibling directory.",
		);
	}
	const value = argv[index + 1];
	if (!value) throw new Error("--from needs a path");
	return { from: resolve(value) };
}

async function sha256(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

/** Every file under `dir`, as paths relative to it, sorted for stability. */
async function walk(dir, base = dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const found = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await walk(full, base)));
		else if (entry.isFile()) found.push(relative(base, full).split(sep).join("/"));
	}
	return found.sort();
}

/**
 * Entries this script owns. Everything else under `vendor/pi` — notably
 * `README.md` — is left alone, so re-vendoring refreshes the source without
 * deleting the documentation that explains it.
 */
const MANAGED = ["packages", "LICENSE", "tsconfig.json", "manifest.json"];

async function main() {
	const { from } = parseArgs(process.argv.slice(2));

	// Fail before touching anything: a half-copied vendor tree is worse than none.
	for (const name of PACKAGES) {
		const source = join(from, "packages", name, "src");
		const info = await stat(source).catch(() => undefined);
		if (!info?.isDirectory()) throw new Error(`not a pi checkout, or package missing: ${source}`);
	}

	await mkdir(DEST, { recursive: true });
	for (const entry of MANAGED) {
		await rm(join(DEST, entry), { recursive: true, force: true });
	}

	const files = {};
	const versions = {};

	for (const name of PACKAGES) {
		const source = join(from, "packages", name, "src");
		const target = join(DEST, "packages", name, "src");
		await mkdir(dirname(target), { recursive: true });
		await cp(source, target, { recursive: true });

		const manifest = JSON.parse(await readFile(join(from, "packages", name, "package.json"), "utf-8"));
		versions[name] = manifest.version;

		for (const file of await walk(target)) {
			files[`packages/${name}/src/${file}`] = await sha256(join(target, file));
		}
	}

	await cp(join(from, "LICENSE"), join(DEST, "LICENSE"));

	// The monorepo tsconfig is the source of the `paths` mappings, which include
	// hand-tuned subpath entries (`pi-coding-agent/hooks` and friends). Copying
	// it keeps `scripts/sync-pi-paths.mjs` deriving from upstream instead of from
	// a hand-written list that would quietly drift.
	await cp(join(from, "tsconfig.json"), join(DEST, "tsconfig.json"));

	const manifest = {
		source: from,
		versions,
		vendoredAt: new Date().toISOString().slice(0, 10),
		fileCount: Object.keys(files).length,
		files,
	};
	await writeFile(join(DEST, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`, "utf-8");

	process.stdout.write(`vendored ${PACKAGES.length} packages (${manifest.fileCount} files)\n`);
	for (const [name, version] of Object.entries(versions)) {
		process.stdout.write(`  ${name.padEnd(14)} ${version}\n`);
	}
	process.stdout.write(`from ${from}\n`);
}

await main();
