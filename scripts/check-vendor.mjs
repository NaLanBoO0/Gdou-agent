/**
 * Verify that the vendored pi source is untouched.
 *
 * `vendor/pi/` is upstream code we do not own. Saying so in a README is a
 * promise; this makes it a fact. Anything modified, added, or deleted under
 * `vendor/pi/` fails the check, so a change there cannot ride along unnoticed
 * inside an unrelated commit.
 *
 * Run with: npm run check:vendor
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "pi");
const MANIFEST = join(VENDOR, "manifest.json");

let failures = 0;

function fail(message) {
	failures += 1;
	process.stdout.write(`  FAIL ${message}\n`);
}

async function sha256(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

/** Every file under `dir`, relative and slash-separated, sorted. */
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

async function main() {
	const manifest = JSON.parse(await readFile(MANIFEST, "utf-8"));
	const expected = manifest.files;

	process.stdout.write(
		`vendored ${manifest.fileCount} files from pi ${Object.values(manifest.versions).join(" / ")} (${manifest.vendoredAt})\n\n`,
	);

	// Only the source tree is compared; the manifest and the README next to it
	// are ours, and LICENSE is copied verbatim but not hashed.
	const actual = (await walk(join(VENDOR, "packages"))).map((file) => `packages/${file}`);
	const actualSet = new Set(actual);
	const expectedSet = new Set(Object.keys(expected));

	const removed = [...expectedSet].filter((file) => !actualSet.has(file));
	const added = actual.filter((file) => !expectedSet.has(file));

	if (removed.length > 0) {
		fail(`${removed.length} vendored file(s) are missing`);
		for (const file of removed.slice(0, 10)) process.stdout.write(`         ${file}\n`);
		if (removed.length > 10) process.stdout.write(`         … and ${removed.length - 10} more\n`);
	}

	if (added.length > 0) {
		fail(`${added.length} file(s) were added to vendor/pi`);
		for (const file of added.slice(0, 10)) process.stdout.write(`         ${file}\n`);
		if (added.length > 10) process.stdout.write(`         … and ${added.length - 10} more\n`);
	}

	// Hashing only the files that exist keeps the two failure modes separate:
	// a missing file is already reported above, and reading it here would throw.
	let changed = 0;
	for (const file of actual) {
		if (!expectedSet.has(file)) continue;
		if ((await sha256(join(VENDOR, file))) !== expected[file]) {
			changed += 1;
			if (changed <= 10) process.stdout.write(`         modified: ${file}\n`);
		}
	}
	if (changed > 0) {
		fail(`${changed} vendored file(s) were modified`);
		if (changed > 10) process.stdout.write(`         … and ${changed - 10} more\n`);
	}

	const checked = actual.filter((file) => expectedSet.has(file)).length;
	process.stdout.write(`  ok   ${checked} file(s) match the manifest\n`);

	if (failures > 0) {
		process.stdout.write(
			"\nvendor/pi is upstream code and must stay byte-identical.\n" +
				"Put the change in src/ instead, or re-vendor deliberately:\n" +
				"  node scripts/vendor-pi.mjs --from <pi checkout>\n",
		);
		process.exit(1);
	}

	process.stdout.write("\nAll checks passed.\n");
}

main().catch((error) => {
	process.stderr.write(`\nVendor check crashed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
