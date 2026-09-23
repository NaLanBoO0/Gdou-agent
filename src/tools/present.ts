/**
 * Artifact delivery.
 *
 * Without this tool a produced file is just a path in a transcript: the model
 * says "I wrote report.html" and the user has to go find it. `present_files`
 * is the explicit hand-off — it turns a path into something the interface can
 * show, and it is what makes "the agent made me something" a real outcome
 * rather than a claim.
 *
 * Three rules, all of them about not guessing:
 *
 *   1. **Paths must be absolute.** A relative path would be resolved against
 *      whichever directory happened to be current, and a wrong guess here
 *      presents the wrong file as the deliverable. Failing the whole call is
 *      better than delivering something adjacent.
 *   2. **The file must exist.** A card for a file that is not there is a lie
 *      the user only discovers by clicking.
 *   3. **Directories are refused.** The tool presents files; a folder is not
 *      something that can be shown, and silently expanding one would produce a
 *      card the user did not ask for.
 *
 * Every item is validated before any of them is reported, so a partially
 * valid call fails as a whole rather than delivering half a set.
 */

import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, extname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** How the interface should render an item, decided here so it does not have to guess. */
export type PreviewKind = "html" | "image" | "pdf" | "text" | "url" | "none";

export interface PresentedItem {
	/** What the caller passed in, echoed for error messages and for the UI. */
	source: string;
	/** Absolute path for a file, or the URL as given. */
	target: string;
	/** Display name: the file's basename, or the URL's last path segment. */
	name: string;
	kind: "file" | "url";
	size?: number;
	/** Lowercased, without the dot. Absent for URLs with no extension. */
	extension?: string;
	preview: PreviewKind;
}

const EXTENSION_PREVIEW: Record<string, PreviewKind> = {
	html: "html",
	htm: "html",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	svg: "image",
	pdf: "pdf",
	txt: "text",
	md: "text",
	json: "text",
	csv: "text",
	tsv: "text",
	log: "text",
	yaml: "text",
	yml: "text",
	toml: "text",
	xml: "text",
	ts: "text",
	tsx: "text",
	js: "text",
	jsx: "text",
	mjs: "text",
	cjs: "text",
	css: "text",
	py: "text",
	sh: "text",
	sql: "text",
};

function previewFor(extension: string | undefined): PreviewKind {
	if (extension === undefined) return "none";
	return EXTENSION_PREVIEW[extension] ?? "none";
}

/** Classify one entry, or explain why it cannot be presented. */
function classify(source: string): PresentedItem | { error: string } {
	const trimmed = source.trim();
	if (trimmed.length === 0) return { error: "空条目" };

	if (/^https?:\/\//i.test(trimmed)) {
		let name: string;
		try {
			const url = new URL(trimmed);
			name = basename(url.pathname) || url.hostname;
		} catch {
			return { error: `不是合法的 URL：${trimmed}` };
		}
		const extension = extname(new URL(trimmed).pathname).slice(1).toLowerCase() || undefined;
		return { source: trimmed, target: trimmed, name, kind: "url", extension, preview: "url" };
	}

	if (!isAbsolute(trimmed)) {
		return {
			error:
				`\`${trimmed}\` 不是绝对路径。相对路径会按当前目录解析，猜错就会把另一个文件当成交付物，` +
				"所以这里直接拒绝而不是替你猜。请传绝对路径。",
		};
	}

	if (!existsSync(trimmed)) return { error: `文件不存在：${trimmed}` };

	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(trimmed);
	} catch (error) {
		return { error: `无法读取：${trimmed}（${(error as Error).message}）` };
	}
	if (stats.isDirectory()) {
		return { error: `\`${trimmed}\` 是目录。这个工具交付的是文件；目录无法预览，展开它会生成用户没要的卡片。` };
	}

	const extension = extname(trimmed).slice(1).toLowerCase() || undefined;
	return {
		source: trimmed,
		target: trimmed,
		name: basename(trimmed),
		kind: "file",
		size: stats.size,
		extension,
		preview: previewFor(extension),
	};
}

export function classifyPresented(sources: readonly string[]): { items: PresentedItem[] } | { errors: string[] } {
	const items: PresentedItem[] = [];
	const errors: string[] = [];
	for (const source of sources) {
		const result = classify(source);
		if ("error" in result) errors.push(result.error);
		else items.push(result);
	}
	// All-or-nothing: a partial delivery reads as success while the user is
	// missing part of what was promised.
	return errors.length > 0 ? { errors } : { items };
}

const presentSchema = Type.Object({
	items: Type.Array(Type.String({ description: "Absolute file path, or an http(s) URL" }), {
		description: "Files or links to hand to the user. Absolute paths only.",
		minItems: 1,
	}),
});

export const presentFilesTool: AgentTool<typeof presentSchema, { items: PresentedItem[] }> = {
	name: "present_files",
	label: "Present files",
	description:
		"Hand finished artifacts to the user so the interface can show them. " +
		"Call this once with everything the turn produced, before the final reply. " +
		"Paths must be absolute; URLs must be http(s).",
	parameters: presentSchema,

	async execute(_toolCallId, params) {
		const result = classifyPresented(params.items);
		if ("errors" in result) {
			return {
				content: [{ type: "text" as const, text: `无法交付：\n- ${result.errors.join("\n- ")}` }],
				isError: true,
				details: { items: [] },
			};
		}
		const lines = result.items.map((item) =>
			item.kind === "url" ? `- ${item.name}（链接）` : `- ${item.name}（${formatSize(item.size ?? 0)}）`,
		);
		return {
			content: [{ type: "text" as const, text: `已交付 ${result.items.length} 项：\n${lines.join("\n")}` }],
			details: { items: result.items },
		};
	},
};

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
