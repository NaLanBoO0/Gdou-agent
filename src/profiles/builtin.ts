/**
 * Modes that ship with the agent, stored as raw markdown.
 *
 * Two decisions are baked into this file, and both are the point of the mode
 * layer rather than an implementation detail.
 *
 * **Why markdown, not TypeScript objects.** A built-in mode goes through the
 * same `parseFrontmatter` a user's file goes through. If the built-ins were
 * written as objects, the built-ins and the file format would drift apart — and
 * the file format is the one users actually write. If the parser breaks, the
 * built-ins break with it, which is exactly what we want to find out.
 *
 * **Why inline strings and not `resources/modes/*.md`.** Because
 * `scripts/build.mjs` copies only `renderer/`, so a `resources/` directory does
 * not survive bundling: a packaged app would find no built-in modes at all. The
 * files a *user* writes are still real files (`~/.gdou-agent/modes/*.md`); only
 * the shipped ones are inline. That is the same trade the built-in experts
 * already make.
 *
 * The ids here are the filenames the equivalent user file would have; a
 * built-in has no filename, so they are stated explicitly.
 */

/** Raw markdown, exactly as a user file would be written. */
export const BUILTIN_MODES: ReadonlyArray<{ id: string; source: string }> = [
	{
		id: "general",
		source: `---
name: General
description: "Everyday tasks: questions, planning, drafting, light analysis. Has file and shell access when a task needs it."
tools: [current_time, save_note, list_notes, read, bash, edit, write, grep, find, ls, present_files, web_search, web_fetch]
thinkingLevel: "off"
---

You are a helpful general-purpose assistant.

You handle everyday tasks: answering questions, planning, drafting, organizing
information, and light analysis.

Guidelines:
- Answer directly and concisely. Lead with the answer, then explain if needed.
- Use tools when they genuinely help; do not narrate tool use.
- You have file and shell access. Use it when a task actually needs it — read a
  file to answer a question about it, run a command to verify a claim — but do
  not reach for the filesystem for questions you can answer directly.
`,
	},
	{
		id: "coding",
		source: `---
name: Coding
description: "Repository work: read, search, edit, write, and run commands."
tools: [read, bash, edit, write, grep, find, ls, present_files, web_search, web_fetch]
toolExecution: parallel
---

You are a coding assistant working inside a software repository.

Guidelines:
- Read a file before editing it. Do not guess at contents.
- Prefer targeted edits over full rewrites.
- Match the surrounding code style and existing conventions.
- After changing code, run the project's checks if it defines them.
- Keep responses concise and technical. No filler.
- Do not commit unless explicitly asked.
`,
	},
];
