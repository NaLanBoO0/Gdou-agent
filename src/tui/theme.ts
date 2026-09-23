/**
 * TUI theme.
 *
 * Deliberately narrow. A Codex-style interface leans on the terminal's own
 * foreground colour and uses exactly one accent, so most of what a full theme
 * system would define is absent here on purpose. Adding colour to a new element
 * should be a deliberate choice, not a default.
 *
 * Two modes are supported because dark terminals and light terminals need
 * opposite treatment for dim text: dimming black text makes it unreadable.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export type ThemeMode = "dark" | "light";

const ESC = "\u001b[";

export interface TuiTheme {
	readonly mode: ThemeMode;
	/** Whether ANSI output is emitted at all. */
	readonly colors: boolean;
	/** Body text. Uses the terminal default in most cases. */
	text(s: string): string;
	/** Secondary information: metadata, hints, paths. */
	dim(s: string): string;
	/** Extra-muted, for separators and the least important chrome. */
	faint(s: string): string;
	bold(s: string): string;
	italic(s: string): string;
	/** The single accent. Markers, prompt, active state. */
	accent(s: string): string;
	success(s: string): string;
	error(s: string): string;
	warning(s: string): string;
	/** Inline code and code blocks. */
	code(s: string): string;
	/** Horizontal rules. */
	rule(s: string): string;
	markdown: MarkdownTheme;
	editor: EditorTheme;
	selectList: SelectListTheme;
}

/** Decide whether to emit ANSI. Mirrors the conventions most CLIs follow. */
export function detectColors(): boolean {
	if (process.env.NO_COLOR !== undefined) return false;
	if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
	if (process.env.TERM === "dumb") return false;
	return true;
}

/**
 * Best-effort theme detection from the environment. The TUI can refine this by
 * querying the terminal background, but env detection covers the common cases
 * without a round trip.
 */
export function detectThemeMode(): ThemeMode {
	const explicit = process.env.PI_AGENT_THEME;
	if (explicit === "dark" || explicit === "light") return explicit;
	// COLORFGBG is "fg;bg"; a light background usually has a high bg index.
	const colorFgBg = process.env.COLORFGBG;
	if (colorFgBg) {
		const parts = colorFgBg.split(";");
		const bg = Number(parts[parts.length - 1]);
		if (Number.isFinite(bg) && bg >= 7) return "light";
	}
	return "dark";
}

function makeStyle(open: string, close: string, enabled: boolean) {
	return (text: string): string => (enabled ? `${ESC}${open}m${text}${ESC}${close}m` : text);
}

export function createTheme(mode: ThemeMode = detectThemeMode(), colors: boolean = detectColors()): TuiTheme {
	// Palette: dark mode brightens the accent so it reads on black; light mode
	// darkens it so it reads on white.
	const accentCode = mode === "dark" ? "36" : "34";
	const successCode = mode === "dark" ? "32" : "32";
	const errorCode = mode === "dark" ? "31" : "31";
	const warningCode = mode === "dark" ? "33" : "33";
	const codeCode = mode === "dark" ? "36" : "35";

	const accent = makeStyle(accentCode, "39", colors);
	const success = makeStyle(successCode, "39", colors);
	const error = makeStyle(errorCode, "39", colors);
	const warning = makeStyle(warningCode, "39", colors);
	const code = makeStyle(codeCode, "39", colors);

	const text = (s: string): string => s;
	const dim = makeStyle("2", "22", colors);
	const faint = makeStyle("2", "22", colors);
	const bold = makeStyle("1", "22", colors);
	const italic = makeStyle("3", "23", colors);
	const underline = makeStyle("4", "24", colors);
	const inverse = makeStyle("7", "27", colors);
	const rule = makeStyle("2", "22", colors);

	const markdown: MarkdownTheme = {
		heading: (s) => bold(accent(s)),
		link: (s) => underline(accent(s)),
		linkUrl: (s) => dim(s),
		code,
		codeBlock: (s) => s,
		codeBlockBorder: (s) => faint(s),
		quote: (s) => dim(s),
		quoteBorder: (s) => faint(s),
		hr: (s) => faint(s),
		listBullet: (s) => accent(s),
		bold,
		italic,
		strikethrough: (s) => dim(s),
		underline,
	};

	const selectList: SelectListTheme = {
		selectedPrefix: (s) => accent(s),
		selectedText: (s) => bold(s),
		description: (s) => dim(s),
		scrollInfo: (s) => dim(s),
		noMatch: (s) => dim(s),
	};

	const editor: EditorTheme = {
		borderColor: (s) => faint(s),
		selectList,
	};

	return {
		mode,
		colors,
		text,
		dim,
		faint,
		bold,
		italic,
		accent,
		success,
		error,
		warning,
		code,
		rule,
		markdown,
		editor,
		selectList,
	};
}

/** Reverse video, used to mark a cursor position in custom components. */
export function inverse(s: string, colors: boolean): string {
	return colors ? `${ESC}7m${s}${ESC}27m` : s;
}
