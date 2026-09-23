/**
 * Startup mode picker.
 *
 * Shown once at launch, before any conversation exists. Kept to a title, the
 * list, and a key hint: at this point the user has no context to help them
 * decide, so the descriptions carry the weight and the chrome should not.
 */

import type { Component, SelectItem } from "@earendil-works/pi-tui";
import { matchesKey, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.ts";

export interface ProfileChoice {
	id: string;
	label: string;
	description: string;
}

export interface ProfilePickerOptions {
	theme: TuiTheme;
	profiles: ProfileChoice[];
	title?: string;
	onSelect: (profileId: string) => void;
	onCancel: () => void;
}

export class ProfilePicker implements Component {
	private readonly theme: TuiTheme;
	private readonly list: SelectList;
	private readonly title: string;
	private readonly onCancel: () => void;

	constructor(options: ProfilePickerOptions) {
		this.theme = options.theme;
		this.title = options.title ?? "Select a mode";

		const items: SelectItem[] = options.profiles.map((profile) => ({
			value: profile.id,
			label: profile.label,
			description: profile.description,
		}));

		this.list = new SelectList(items, items.length, options.theme.selectList);
		this.list.onSelect = (item) => options.onSelect(item.value);
		this.onCancel = options.onCancel;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onCancel();
			return;
		}
		this.list.handleInput(data);
	}

	/** Move the highlight, e.g. to restore the last used mode. */
	selectIndex(index: number): void {
		this.list.setSelectedIndex(index);
	}

	render(width: number): string[] {
		const inner = Math.max(20, width);
		const out: string[] = [];

		out.push(this.theme.bold(this.title));
		out.push("");

		for (const line of this.list.render(inner)) out.push(line);

		out.push("");
		out.push(this.theme.faint("↑↓ select · enter confirm · esc cancel"));

		return out.map((line) => truncateToWidth(line, width, "…"));
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
