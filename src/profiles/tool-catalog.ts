/**
 * The tool catalog: the set of tool names a mode's frontmatter may refer to.
 *
 * Modes are markdown files, so the frontmatter holds tool *names* and this file
 * is what turns a name into a tool. That indirection is the whole design: it is
 * what lets "add a mode" be "add a file" without letting a file conjure a
 * capability that does not exist in code.
 *
 * The consequence is worth stating plainly, because it is the honest limit of
 * the promise: a mode that *combines* existing tools needs no code, but a mode
 * that needs a tool nobody wrote yet still needs one added here. Tools are
 * code, and a data file cannot supply code without becoming code.
 *
 * Entries are factories rather than instances because pi's tools are bound to a
 * working directory at construction time. A catalog of instances would freeze
 * whichever directory happened to be current when the module loaded.
 */

import { createTool, type ToolName } from "@earendil-works/pi-coding-agent/core/tools/index.ts";
import type { AnyTool } from "./types.ts";
import { currentTimeTool } from "../tools/time.ts";
import { listNotesTool, saveNoteTool } from "../tools/notes.ts";
import { presentFilesTool } from "../tools/present.ts";
import { webFetchTool } from "../tools/web-fetch.ts";
import { webSearchTool } from "../tools/web-search.ts";

/**
 * Build a tool for a working directory, or `undefined` when this build of the
 * agent cannot offer it.
 *
 * `undefined` is a legitimate answer, not an error: pi's `powershell` tool is
 * only meaningful on Windows, and a mode naming it on another platform should
 * end up with a smaller tool set rather than a session that refuses to start.
 */
export type ToolFactory = (cwd: string) => AnyTool | undefined;

/** pi's own tools, constructed on demand for the requested directory. */
const PI_TOOL_NAMES: readonly ToolName[] = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
];

/**
 * Tools this project contributes.
 *
 * They are stateless — none of them is bound to a directory — so the factory
 * ignores `cwd` and returns the shared instance. Keeping the factory shape
 * uniform is worth more than the allocation saved by making the catalog a
 * heterogeneous map.
 */
const OWN_TOOLS: Record<string, AnyTool> = {
	current_time: currentTimeTool as unknown as AnyTool,
	save_note: saveNoteTool as unknown as AnyTool,
	list_notes: listNotesTool as unknown as AnyTool,
	present_files: presentFilesTool as unknown as AnyTool,
	web_fetch: webFetchTool as unknown as AnyTool,
	web_search: webSearchTool as unknown as AnyTool,
};

/**
 * Every name a mode may use. The key set is also the validation set: an
 * unknown name in a frontmatter is reported at load time against this list,
 * which is the difference between a typo being a one-line fix and being an
 * inexplicably missing tool.
 */
export const TOOL_FACTORIES: Readonly<Record<string, ToolFactory>> = {
	...Object.fromEntries(
		PI_TOOL_NAMES.map((name) => [name, (cwd: string) => createTool(name, cwd) as unknown as AnyTool]),
	),
	...Object.fromEntries(Object.entries(OWN_TOOLS).map(([name, tool]) => [name, () => tool])),
};

/** Every tool name a mode file may name, sorted. Used for validation messages. */
export const TOOL_NAMES: readonly string[] = Object.keys(TOOL_FACTORIES).sort();

/** Resolve one tool by name, or `undefined` when it does not exist. */
export function resolveTool(name: string, cwd: string): AnyTool | undefined {
	return TOOL_FACTORIES[name]?.(cwd);
}
