/**
 * Web search.
 *
 * There is no keyless option worth shipping. Scraping a search engine's HTML
 * endpoint is fragile by construction (the markup changes without notice), and
 * a tool that silently returns nothing is worse than one that says it is not
 * configured. So this requires a provider, and supports the two that need
 * nothing but a single key.
 *
 * **The key comes from the environment, not from `settings.json`.** That is a
 * security decision rather than a convenience one: the permission gate allows
 * tools to *read* the program's config file (it only blocks writing it), so a
 * key stored there would be readable by any tool the model calls. Provider keys
 * live in `auth.json`, which is denied for read and write; a search key kept in
 * the environment is at least as protected.
 *
 * Moving this into a settings screen later means finding it a protected store
 * first — not just adding a text field.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { FETCH_TIMEOUT_MS } from "./net-guard.ts";

export type SearchProvider = "brave" | "tavily";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Where each provider's key is read from, and how it is described. */
const PROVIDERS: Record<SearchProvider, { envVar: string; label: string }> = {
	brave: { envVar: "BRAVE_API_KEY", label: "Brave Search" },
	tavily: { envVar: "TAVILY_API_KEY", label: "Tavily" },
};

/** The configured provider, or undefined when no key is present. */
export function resolveSearchProvider(
	env: NodeJS.ProcessEnv = process.env,
): { provider: SearchProvider; key: string } | undefined {
	for (const provider of ["brave", "tavily"] as const) {
		const key = env[PROVIDERS[provider].envVar];
		if (key && key.trim().length > 0) return { provider, key: key.trim() };
	}
	return undefined;
}

/** How to configure search, shown when it is not configured. */
export function searchSetupHint(): string {
	const lines = (Object.keys(PROVIDERS) as SearchProvider[]).map(
		(p) => `  ${PROVIDERS[p].label.padEnd(14)} ${PROVIDERS[p].envVar}`,
	);
	return ["联网搜索需要一个搜索服务商的 key，设其中一个环境变量即可：", ...lines].join("\n");
}

const MAX_RESULTS = 8;

async function searchBrave(query: string, key: string, count: number): Promise<SearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));

	const response = await fetch(url, {
		headers: { accept: "application/json", "x-subscription-token": key },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Brave 返回 HTTP ${response.status}`);

	const body = (await response.json()) as { web?: { results?: Array<Record<string, unknown>> } };
	return (body.web?.results ?? []).slice(0, count).map((item) => ({
		title: String(item.title ?? ""),
		url: String(item.url ?? ""),
		snippet: String(item.description ?? ""),
	}));
}

async function searchTavily(query: string, key: string, count: number): Promise<SearchResult[]> {
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ api_key: key, query, max_results: count }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Tavily 返回 HTTP ${response.status}`);

	const body = (await response.json()) as { results?: Array<Record<string, unknown>> };
	return (body.results ?? []).slice(0, count).map((item) => ({
		title: String(item.title ?? ""),
		url: String(item.url ?? ""),
		snippet: String(item.content ?? ""),
	}));
}

export async function runSearch(
	query: string,
	count: number,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SearchResult[]> {
	const resolved = resolveSearchProvider(env);
	if (!resolved) throw new Error(searchSetupHint());
	const limit = Math.max(1, Math.min(MAX_RESULTS, count));
	return resolved.provider === "brave"
		? searchBrave(query, resolved.key, limit)
		: searchTavily(query, resolved.key, limit);
}

const searchSchema = Type.Object({
	query: Type.String({ description: "Search terms" }),
	count: Type.Optional(Type.Number({ description: `How many results, 1-${MAX_RESULTS}. Default 5.` })),
});

export const webSearchTool: AgentTool<typeof searchSchema, { query: string; results: SearchResult[] }> = {
	name: "web_search",
	label: "Web search",
	description:
		"Search the web and return titles, URLs, and snippets. " +
		"Follow up with web_fetch to read a result in full. " +
		"Requires a search provider key in the environment.",
	parameters: searchSchema,

	async execute(_toolCallId, params) {
		try {
			const results = await runSearch(params.query, params.count ?? 5);
			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: `没有找到与「${params.query}」相关的结果。` }],
					details: { query: params.query, results: [] },
				};
			}
			const body = results
				.map((item, index) => `${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet}`)
				.join("\n\n");
			return {
				content: [{ type: "text" as const, text: body }],
				details: { query: params.query, results },
			};
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `搜索失败：${(error as Error).message}` }],
				isError: true,
				details: { query: params.query, results: [] },
			};
		}
	},
};
