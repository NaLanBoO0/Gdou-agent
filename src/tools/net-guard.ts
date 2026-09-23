/**
 * URL safety for the outbound tools.
 *
 * `web_fetch` is the first tool that can reach the network on the model's
 * behalf, which makes it the first place a model-authored string becomes an
 * outbound request. That matters because the request originates *inside* this
 * process: `http://127.0.0.1:9222/json` or `http://169.254.169.254/...` reaches
 * services that are only reachable from the machine itself, and the reply is
 * handed straight back into the conversation.
 *
 * So the check is not "is this a well-formed URL" — it is "is this a host the
 * user could have meant". Loopback, private ranges, link-local (which is where
 * cloud instance metadata lives), and anything carrying credentials are refused.
 *
 * **DNS rebinding is not defended against.** A hostname that resolves to a
 * private address at request time passes the literal check here. Closing that
 * needs resolution-then-pin, which means owning the socket; this guard raises
 * the bar, it does not establish a boundary — the same honesty as
 * `command-guard.ts`.
 */

/** IPv4 ranges that are not routable on the public internet. */
const PRIVATE_IPV4 = [
	/^0\./,
	/^10\./,
	/^127\./,
	/^169\.254\./, // link-local, incl. cloud metadata at 169.254.169.254
	/^172\.(?:1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

/** Hostnames that always mean "this machine" or "this network". */
const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "metadata.google.internal"]);

export interface UrlVerdict {
	ok: boolean;
	/** Why it was refused. Shown to the model so it can pick another URL. */
	reason?: string;
}

/**
 * Decide whether an outbound request to `raw` is allowed.
 *
 * Only `http:` and `https:` are accepted. `file:` would be a filesystem read
 * that bypasses the permission gate entirely, and the rest (`gopher:`,
 * `data:`, custom schemes) exist mainly as ways to reach something unexpected.
 */
export function inspectUrl(raw: string): UrlVerdict {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: `\`${raw}\` 不是合法的 URL。` };
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return {
			ok: false,
			reason: `只允许 http 与 https，收到的是 \`${url.protocol}\`。其他协议（尤其 file:）会绕过权限门直接读本地文件。`,
		};
	}

	// Credentials in the URL are sent as a header the user never sees, and are a
	// common way to smuggle a secret into a request the model composed.
	if (url.username.length > 0 || url.password.length > 0) {
		return { ok: false, reason: "URL 里带了用户名或密码。请去掉凭据，需要鉴权请另行说明。" };
	}

	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

	if (LOCAL_HOSTNAMES.has(host)) {
		return { ok: false, reason: `\`${host}\` 指向本机。这个请求从本机发出，会打到只在本机可达的服务。` };
	}

	// A bare IPv4 or IPv6 literal can be judged directly.
	if (PRIVATE_IPV4.some((pattern) => pattern.test(host))) {
		return { ok: false, reason: `\`${host}\` 是内网或回环地址，拒绝。` };
	}
	if (host.includes(":")) {
		// IPv6: ::1 loopback, fe80::/10 link-local, fc00::/7 unique-local.
		if (/^(?:::1|::)$/.test(host) || /^fe[89ab]/.test(host) || /^f[cd]/.test(host)) {
			return { ok: false, reason: `\`${host}\` 是 IPv6 回环或内网地址，拒绝。` };
		}
	}
	// `0.0.0.0`, `127.1`, and decimal-encoded forms all normalise to a loopback
	// or wildcard address that a string check on the dotted form would miss.
	if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
		return { ok: false, reason: `\`${host}\` 是整数形式的地址，可能指向本机，拒绝。` };
	}

	return { ok: true };
}

/** Largest body `web_fetch` will read, before extraction. */
export const MAX_FETCH_BYTES = 3 * 1024 * 1024;

/** Requests give up after this long, so a hanging host cannot stall a run. */
export const FETCH_TIMEOUT_MS = 20_000;

/** Redirects are followed, but only this many, and each hop is re-checked. */
export const MAX_REDIRECTS = 5;
