/**
 * Coding tool check.
 *
 * Verifies that the tools in the coding profile actually work, offline, with no
 * API key. The point is the last part: `grep` and `find` do not search by
 * themselves, they exec ripgrep and fd, and pi would otherwise download those
 * on first use. A machine without internet therefore has two tools that return
 * nothing and report nothing. Asserting that the binaries exist is not enough
 * either — a truncated or wrong-architecture binary sits there looking fine
 * until something tries to run it.
 *
 * So this runs the tools for real against a fixture directory and checks the
 * results. It never touches the network: if the binaries are missing, the tools
 * would try to download, and the check fails with that as the stated reason
 * rather than hanging or passing vacuously.
 *
 * Run with: npm run check:tools
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllTools } from "@earendil-works/pi-coding-agent/core/tools/index.ts";
import { getToolPath } from "@earendil-works/pi-coding-agent/utils/tools-manager.ts";
import { toolchainPaths } from "../src/kernel/toolchain.ts";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
	checks += 1;
	if (condition) {
		process.stdout.write(`  [ok  ] ${label}\n`);
		return;
	}
	failures += 1;
	process.stdout.write(`  [FAIL] ${label}${detail === undefined ? "" : ` -> ${detail}`}\n`);
}

/** Flatten a tool result into plain text. */
function textOf(result: { content?: readonly { type?: string; text?: string }[] }): string {
	return (result.content ?? [])
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n")
		.trim();
}

/** A small tree with content that is unambiguous to search for. */
async function makeFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "gdou-tools-"));
	await mkdir(join(root, "nested"), { recursive: true });
	await writeFile(join(root, "alpha.txt"), "the needle lives here\nsecond line\n", "utf-8");
	await writeFile(join(root, "nested", "beta.txt"), "nothing to find\n", "utf-8");
	await writeFile(join(root, "nested", "gamma.json"), '{"needle": true}\n', "utf-8");
	return root;
}

async function main(): Promise<void> {
	const paths = toolchainPaths();

	process.stdout.write(`tool bin dir: ${paths.binDir}\n\n`);

	process.stdout.write("managed binaries\n");
	for (const name of ["rg", "fd"] as const) {
		const resolved = getToolPath(name);
		check(`${name} resolves to a path`, typeof resolved === "string" && resolved.length > 0, String(resolved));
	}

	const fixture = await makeFixture();
	try {
		const tools = createAllTools(fixture);

		process.stdout.write("\ngrep\n");
		const grep = await tools.grep.execute("t1", { pattern: "needle" });
		const grepText = textOf(grep);
		check("finds a match in a text file", grepText.includes("alpha.txt"), grepText.slice(0, 200));
		check("reports the matching line", grepText.includes("the needle lives here"), grepText.slice(0, 200));
		check("finds a match inside a nested directory", grepText.includes("gamma.json"), grepText.slice(0, 200));

		// A miss is reported as a message, not an empty string and not a throw.
		// The invariant worth asserting is that no fixture file is named.
		const noMatch = textOf(await tools.grep.execute("t2", { pattern: "a-string-that-is-not-there" }));
		check(
			"reports no match without failing",
			!noMatch.includes("alpha.txt") && !noMatch.includes("gamma.json"),
			noMatch.slice(0, 120),
		);

		process.stdout.write("\nfind\n");
		const find = textOf(await tools.find.execute("t3", { pattern: "*.txt" }));
		check("finds files by glob", find.includes("alpha.txt"), find.slice(0, 200));
		check("finds files in subdirectories", find.includes("beta.txt"), find.slice(0, 200));

		const json = textOf(await tools.find.execute("t4", { pattern: "*.json" }));
		check("respects the glob extension", json.includes("gamma.json") && !json.includes("alpha.txt"), json.slice(0, 200));

		process.stdout.write("\nls and read\n");
		const ls = textOf(await tools.ls.execute("t5", {}));
		check("lists directory entries", ls.includes("alpha.txt") && ls.includes("nested"), ls.slice(0, 200));

		const read = textOf(await tools.read.execute("t6", { path: join(fixture, "alpha.txt") }));
		check("reads file contents", read.includes("the needle lives here"), read.slice(0, 120));
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}

	process.stdout.write(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

await main();
