/**
 * Reading a directory of markdown definitions.
 *
 * Experts and modes are both "a directory of `*.md`, most specific wins", and
 * the two failure policies in here are deliberate enough to be worth writing
 * once instead of twice.
 *
 * **A missing directory is normal.** Most projects have no project-level
 * definitions, and most users have none at home. That is an empty result, not
 * an error — erroring would make the common case the noisy one.
 *
 * **A file that exists but does not parse is an error, not a skip.** Silently
 * ignoring a malformed definition is indistinguishable from a typo in the id
 * the user typed: they ask for `secuirty-audit`, get "unknown", and have no way
 * to see that the file they wrote is broken. So the failure is collected and
 * surfaced at the call site, where it can be shown next to the list of things
 * that did load.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const MARKDOWN = ".md";

export interface DirectoryLoad<T> {
	/** Definitions that parsed, in filename order. */
	items: T[];
	/** Files that exist but could not be loaded, with the reason. */
	errors: string[];
}

/**
 * Read every `*.md` in `dir` through `parse`.
 *
 * `parse` receives the id (the filename stem), the path — so errors can name
 * the file the user has to open — and the raw text. It is expected to throw on
 * anything it cannot accept; the message is what the user will see.
 */
export function loadDefinitionDir<T>(
	dir: string,
	parse: (id: string, path: string, raw: string) => T,
): DirectoryLoad<T> {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { items: [], errors: [] };
	}

	const items: T[] = [];
	const errors: string[] = [];
	for (const name of names.sort()) {
		if (extname(name).toLowerCase() !== MARKDOWN) continue;
		const path = join(dir, name);
		try {
			if (!statSync(path).isFile()) continue;
			items.push(parse(basename(name, extname(name)), path, readFileSync(path, "utf-8")));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { items, errors };
}
