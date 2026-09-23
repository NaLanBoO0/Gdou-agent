/**
 * Minimal ANSI styling.
 *
 * Deliberately dependency-free: this project resolves bare imports through
 * tsconfig paths that only cover pi's own packages, so pulling in chalk would
 * mean adding a local node_modules. Raw escapes cost nothing and are enough for
 * a CLI. The TUI will use pi-tui's theme system instead.
 */

const ESC = "\u001b[";

function wrap(open: string, close: string, text: string): string {
	return `${ESC}${open}m${text}${ESC}${close}m`;
}

/** Respect NO_COLOR and non-TTY output. */
const enabled = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

function style(open: string, close: string) {
	return (text: string): string => (enabled ? wrap(open, close, text) : text);
}

export const dim = style("2", "22");
export const bold = style("1", "22");
export const italic = style("3", "23");
export const red = style("31", "39");
export const green = style("32", "39");
export const yellow = style("33", "39");
export const cyan = style("36", "39");
