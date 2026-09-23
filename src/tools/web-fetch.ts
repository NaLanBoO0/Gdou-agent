/**
 * Fetch a web page and return its readable text.
 *
 * The extraction is `@mozilla/readability` — the same code Firefox's reader
 * mode uses — over a `linkedom` DOM. Writing our own "strip the tags" pass
 * would produce a wall of navigation and footer, which is the failure that
 * makes a fetch tool useless in practice.
 *
 * Two things this deliberately does not do:
 *
 *   - **No JavaScript execution.** The response is parsed as static HTML. Pages
 *     that render entirely client-side come back empty, and the tool says so
 *     rather than returning a blank string the model has to interpret.
 *   - **No cookies, no credentials, no session.** Every request is anonymous.
 *
 * The URL is checked by `net-guard` on the way in *and* on every redirect hop,
 * because a public URL that redirects to `127.0.0.1` would otherwise walk
 * straight past a check that only looked at the first hop.
 */

import { Readability } from "@mozilla/readability";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { parseHTML } from "linkedom";
import {
	FETCH_TIMEOUT_MS,
	inspectUrl,
	MAX_FETCH_BYTES,
	MAX_REDIRECTS,
} from "./net-guard.ts";

/** Longest text handed back to the model. */
const MAX_TEXT_CHARS = 24_000;

interface FetchOutcome {
	url: string;
	title: string;
	text: string;
	truncated: boolean;
	/** True when the page yielded nothing extractable — usually JS-rendered. */
	empty: boolean;
}

/**
 * Follow redirects manually so each hop can be checked.
 *
 * `fetch`'s own `redirect: "follow"` would resolve the whole chain internally,
 * which is exactly the part that needs inspecting.
 */
async function fetchChecked(startUrl: string): Promise<{ response: Response; finalUrl: string }> {
	let current = startUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const verdict = inspectUrl(current);
		if (!verdict.ok) throw new Error(verdict.reason);

		const response = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			headers: {
				// Identify honestly rather than impersonating a browser.
				"user-agent": "gdou-agent/0.1 (+https://github.com/gdou-agent)",
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
			},
		});

		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			current = new URL(location, current).toString();
			continue;
		}
		return { response, finalUrl: current };
	}
	throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，放弃。`);
}

/** Read a response body, refusing anything over the cap. */
async function readCapped(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_FETCH_BYTES) {
		throw new Error(`页面 ${(declared / 1024 / 1024).toFixed(1)} MB，超过上限，拒绝下载。`);
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_FETCH_BYTES) {
		throw new Error(`页面超过 ${(MAX_FETCH_BYTES / 1024 / 1024).toFixed(0)} MB，拒绝下载。`);
	}
	return new TextDecoder("utf-8").decode(buffer);
}

export async function fetchReadable(url: string): Promise<FetchOutcome> {
	const { response, finalUrl } = await fetchChecked(url);
	if (!response.ok) {
		throw new Error(`请求失败：HTTP ${response.status} ${response.statusText}`);
	}

	const contentType = response.headers.get("content-type") ?? "";
	// A plain-text or JSON response has nothing to extract; returning it as-is
	// is more useful than running it through a readability pass that finds no
	// article and returns nothing.
	if (!/html/i.test(contentType)) {
		const body = await readCapped(response);
		return {
			url: finalUrl,
			title: finalUrl,
			text: body.slice(0, MAX_TEXT_CHARS),
			truncated: body.length > MAX_TEXT_CHARS,
			empty: body.trim().length === 0,
		};
	}

	const html = await readCapped(response);
	const { document } = parseHTML(html);
	// Readability mutates the document, so the title is taken first.
	const rawTitle = document.title ?? "";
	const article = new Readability(document as unknown as Document).parse();

	const text = (article?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
	return {
		url: finalUrl,
		title: (article?.title || rawTitle || finalUrl).trim(),
		text: text.slice(0, MAX_TEXT_CHARS),
		truncated: text.length > MAX_TEXT_CHARS,
		empty: text.length === 0,
	};
}

const fetchSchema = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to read" }),
});

export const webFetchTool: AgentTool<typeof fetchSchema, FetchOutcome> = {
	name: "web_fetch",
	label: "Fetch page",
	description:
		"Read a web page and return its main text. Use it after web_search to read a result in full. " +
		"Static HTML only — pages that render entirely in JavaScript come back empty.",
	parameters: fetchSchema,

	async execute(_toolCallId, params) {
		try {
			const outcome = await fetchReadable(params.url);
			if (outcome.empty) {
				return {
					content: [
						{
							type: "text" as const,
							text: `\`${outcome.url}\` 没有可提取的正文。这个页面很可能是前端渲染的（本工具不执行 JavaScript）。`,
						},
					],
					isError: true,
					details: outcome,
				};
			}
			const header = `# ${outcome.title}\n${outcome.url}${outcome.truncated ? "\n（内容过长，已截断）" : ""}\n\n`;
			return {
				content: [{ type: "text" as const, text: header + outcome.text }],
				details: outcome,
			};
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `抓取失败：${(error as Error).message}` }],
				isError: true,
				details: { url: params.url, title: "", text: "", truncated: false, empty: true },
			};
		}
	},
};
