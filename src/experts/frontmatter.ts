/**
 * Frontmatter parsing for markdown-backed definitions.
 *
 * Format is the usual one:
 *
 *     ---
 *     name: 安全审计
 *     description: 按攻击面审查代码
 *     tools: [read, grep]
 *     ---
 *
 *     Body text.
 *
 * Parsed with a real YAML library rather than a hand-rolled `key: value`
 * splitter. The subset looks trivial and then is not: a description containing
 * a colon, a quoted string, a multi-line block, a value that is a list. Getting
 * those wrong fails in the confusing direction — the field silently keeps the
 * wrong value instead of erroring — and `yaml` is already a dependency of this
 * project (the vendored pi sources use it), so the real parser costs nothing.
 */

import { parse as parseYaml } from "yaml";

export interface Frontmatter {
	data: Record<string, unknown>;
	body: string;
}

const DELIMITER = "---";

/**
 * Split `raw` into frontmatter data and body.
 *
 * `source` is only used for error messages: a malformed file has to be
 * attributable, or the user has no way to find which one is broken.
 */
export function parseFrontmatter(raw: string, source: string): Frontmatter {
	// A BOM or CRLF endings would otherwise make the first line not match, and
	// "no frontmatter" is a much less useful error than the truth.
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const lines = text.split("\n");

	if (lines[0]?.trim() !== DELIMITER) {
		throw new Error(`${source}: expected the file to start with a "---" frontmatter block`);
	}

	// `findIndex` on a trimmed comparison rather than `indexOf`: a closing
	// delimiter with trailing whitespace is still a delimiter, and requiring an
	// exact match would report "never closed" for a file that plainly is.
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
	if (end === -1) {
		throw new Error(`${source}: frontmatter block is never closed with "---"`);
	}

	const block = lines.slice(1, end).join("\n");
	const body = lines.slice(end + 1).join("\n").trim();

	let parsed: unknown;
	try {
		parsed = parseYaml(block);
	} catch (error) {
		throw new Error(`${source}: frontmatter is not valid YAML - ${(error as Error).message}`);
	}

	// An empty block parses to null, which is fine; anything else that is not a
	// mapping is a mistake worth reporting.
	if (parsed === null || parsed === undefined) return { data: {}, body };
	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${source}: frontmatter must be a set of key/value pairs`);
	}

	return { data: parsed as Record<string, unknown>, body };
}
