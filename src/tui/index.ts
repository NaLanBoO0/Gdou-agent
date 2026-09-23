/**
 * TUI entry point.
 *
 * Owns the two things a front-end must get right before any conversation
 * exists: refusing to start when the terminal cannot host a UI, and asking
 * which mode to run in.
 *
 * The mode picker runs on a throwaway screen that is stopped before the real
 * UI starts. Sharing one screen across the handoff is possible but the picker's
 * chrome would then have to be unpicked from the transcript; a short-lived
 * screen keeps the two concerns separate, and the selection stays visible above
 * the transcript as a record of what was chosen.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { presetsWithCredentials } from "../config/providers.ts";
import { loadSettings, saveSettings } from "../config/settings.ts";
import { createAgent } from "../kernel/agent.ts";
import { listProfiles } from "../profiles/registry.ts";
import { TuiApp } from "./app.ts";
import { ProfilePicker, type ProfileChoice } from "./components/profile-picker.ts";
import { createTheme, type TuiTheme } from "./theme.ts";

export interface RunTuiOptions {
	/** Skip the picker by naming a profile. */
	profile?: string;
	/**
	 * Expert to layer on the mode.
	 *
	 * Omitted falls back to the stored default; `null` means "none". The picker
	 * only chooses the mode, so there is nothing here that would want to send
	 * `null` on the user's behalf — but the option keeps the tri-state honest
	 * for callers that do.
	 */
	expert?: string | null;
	/** Model as "provider/modelId". */
	model?: string;
	cwd?: string;
	thinkingLevel?: ThinkingLevel;
	/** Force the picker on or off. Defaults to on unless a profile was given. */
	selectProfile?: boolean;
	/** Persist the picked profile to settings. Defaults to true. */
	rememberProfile?: boolean;
	theme?: TuiTheme;
}

/** Whether this process has an interactive terminal on both ends. */
export function canRunTui(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Start the TUI and return when the user exits.
 *
 * Throws when there is no interactive terminal, or when the agent cannot be
 * built (no provider credentials) - both are conditions the caller should
 * report rather than swallow.
 */
export async function runTui(options: RunTuiOptions = {}): Promise<void> {
	if (!canRunTui()) {
		throw new Error(
			"The interactive UI needs a terminal: stdin and stdout must both be a TTY. " +
				"Pass a prompt as an argument to use the non-interactive mode instead.",
		);
	}

	const theme = options.theme ?? createTheme();
	const settings = loadSettings();

	let profileId = options.profile ?? settings.mode;

	// Ask before building anything, but only when there is something to build
	// with: being made to pick a mode and then told there is no API key is a
	// worse first run than being told immediately.
	const shouldSelect = options.selectProfile ?? options.profile === undefined;
	if (shouldSelect && presetsWithCredentials().length > 0) {
		// Resolved the same way `createAgent` resolves it, so the picker lists
		// the project modes that the session about to be built will actually
		// see. Listing a different set than the one that gets used would make
		// the picker a lie.
		const picked = await selectProfile(theme, profileId, options.cwd ?? settings.cwd);
		if (picked === undefined) return;
		profileId = picked;
		if (options.rememberProfile ?? true) saveSettings({ ...settings, mode: picked });
	}

	const session = await createAgent({
		recipe: { mode: profileId, expert: options.expert },
		model: options.model,
		cwd: options.cwd,
		thinkingLevel: options.thinkingLevel,
		settings,
	});

	const app = new TuiApp({ session, theme });
	try {
		await app.run();
	} finally {
		session.dispose();
	}
}

/**
 * Show the mode picker and resolve with the chosen profile id.
 *
 * Resolves with undefined when the user cancels, which the caller must treat as
 * "do not start", not as "use the default".
 */
async function selectProfile(
	theme: TuiTheme,
	current: string | undefined,
	cwd: string | undefined,
): Promise<string | undefined> {
	const choices: ProfileChoice[] = listProfiles(cwd).map((profile) => ({
		id: profile.id,
		label: profile.label,
		description: profile.description,
	}));
	if (choices.length === 0) return undefined;

	return new Promise<string | undefined>((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal(), true);
		let settled = false;

		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			ui.stop();
			resolve(value);
		};

		const picker = new ProfilePicker({
			theme,
			profiles: choices,
			title: "Select a mode",
			onSelect: (profileId) => finish(profileId),
			onCancel: () => finish(undefined),
		});

		if (current !== undefined) {
			// Pre-select the last used mode so a repeated launch is one keystroke.
			const index = choices.findIndex((choice) => choice.id === current);
			if (index > 0) picker.selectIndex(index);
		}

		ui.addChild(picker);
		ui.setFocus(picker);
		ui.terminal.setTitle("Gdouwork");
		ui.start();
	});
}
