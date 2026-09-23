/**
 * Credential storage.
 *
 * pi's `CredentialStore` defaults to an in-memory implementation —
 * `createModels()` builds one when nothing is supplied — so without a store of
 * our own **nothing a user enters survives the process**. That left environment
 * variables as the only way to reach a provider, which is not something anyone
 * can set from inside a desktop app, and it is why the interface had no way to
 * configure one even though every other part of it was finished.
 *
 * The backing file is `auth.json` next to `settings.json`, in pi's own shape
 * (`Record<providerId, Credential>`) rather than a format of our own. pi already
 * reads that shape (`readStoredCredential`), the resolution rules in
 * `auth/resolve.ts` already understand it, and a second format would be a second
 * thing to keep in step with the first.
 *
 * The *location* is ours rather than pi's, and that was not the first choice.
 * `getAgentDir()` is where pi would look, but it resolves from `homedir()` and
 * ignores `GDOU_AGENT_HOME` — so a store built on it would sit outside the one
 * directory this project promises to own, and `check:gui`, which runs against a
 * throwaway home precisely so it cannot touch real state, would have written to
 * the user's actual credentials. A check that edits the thing it is checking is
 * worse than no check. The shape stays pi's; the path is ours.
 *
 * Three behaviours are worth stating once, because each is easy to get wrong:
 *
 * - **A stored credential owns its provider.** pi consults the environment only
 *   when nothing is stored for that provider, so a key entered in the interface
 *   deliberately overrides `DEEPSEEK_API_KEY` and friends. That is what a person
 *   expects from having entered one, and the opposite of what treating this file
 *   as a cache would give.
 * - **A read never returns a key to the caller that renders it.** `list()`
 *   reports only whether a provider is configured, and the rows the interface
 *   draws carry a masked hint — enough to confirm *which* key is installed,
 *   never enough to use it.
 * - **The file lands by rename, and is created `0600` where that means
 *   anything.** The whole file is a secret, so it needs no group or world bit;
 *   and a crash halfway through a write would otherwise take out every provider
 *   at once rather than the one being edited. The mode is a POSIX promise only:
 *   Windows has no permission bits, `chmod` there just toggles the read-only
 *   attribute, and what protects the file is the ACL on the user profile. Said
 *   out loud because the code cannot express the difference and a comment that
 *   overstates a security property is worse than one that scopes it.
 *
 * The interface is async and the implementation is synchronous on purpose. The
 * work is a few hundred bytes of local file I/O, and doing the read-modify-write
 * synchronously makes it atomic by construction. An async version would have to
 * reinvent mutual exclusion to promise the same thing.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiKeyCredential, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { PROVIDER_PRESETS } from "../config/providers.ts";
import { AGENT_HOME } from "../paths.ts";

/**
 * The credential file. Also the one file a migration has to carry.
 *
 * Under `AGENT_HOME`, so `GDOU_AGENT_HOME` isolates credentials along with
 * everything else — see the note at the top of this file for why pi's own
 * directory was rejected.
 */
export function authPath(): string {
	return join(AGENT_HOME, "auth.json");
}

/** pi's on-disk shape: one credential per provider id. */
type AuthFile = Record<string, Credential>;

const FILE_MODE = 0o600;

/**
 * Read the file, treating every kind of damage as "nothing configured".
 *
 * A missing file, an unreadable one, and a truncated one all mean the same thing
 * to a caller asking "is a provider configured": no. Reported as data rather
 * than as an error because the alternative — refusing to start a session because
 * `auth.json` lost a brace — turns a config typo into a dead application.
 *
 * The write path deliberately does *not* share this tolerance; see `readStrict`.
 */
function readLenient(path: string): AuthFile {
	try {
		const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as AuthFile;
	} catch {
		return {};
	}
}

/**
 * Read the file for a write, refusing to continue if it is damaged.
 *
 * The asymmetry with `readLenient` is the point. Reading a broken file costs the
 * user nothing, but *writing* over one would replace every credential in it with
 * whatever this process happens to know — silently deleting keys that a person
 * could still have recovered by opening the file. So a damaged file stops the
 * write and says so, and the fix stays in the user's hands.
 */
function readStrict(path: string): AuthFile {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
	} catch (error) {
		throw new Error(`${path} exists but could not be read: ${(error as Error).message}`);
	}
	if (raw.trim().length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`${path} is not valid JSON, so it was left untouched. Fix or remove it, then try again` +
				` — writing now would replace every credential it holds.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} should hold a JSON object keyed by provider id, and was left untouched.`);
	}
	return parsed as AuthFile;
}

function writeAuthFile(path: string, data: AuthFile): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp`;
	// `mode` below applies only when the file is created, so an existing file
	// keeps whatever permissions it already had. The explicit chmod is what
	// stops a file that began life readable from staying readable.
	writeFileSync(temp, `${JSON.stringify(data, null, "\t")}\n`, { encoding: "utf-8", mode: FILE_MODE });
	chmodSync(temp, FILE_MODE);
	renameSync(temp, path);
}

/**
 * A `CredentialStore` backed by `auth.json`.
 *
 * Exported for tests, which need a store pointed at a temporary file. Production
 * code goes through `credentialStore()`, so there is one instance and therefore
 * one answer to "what is configured".
 */
export class FileCredentialStore implements CredentialStore {
	readonly path: string;

	constructor(path: string = authPath()) {
		this.path = path;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return readLenient(this.path)[providerId];
	}

	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(readLenient(this.path)).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
	}

	/**
	 * Configured provider ids, read synchronously.
	 *
	 * Exists for `ModelRuntime.credentialReport()`, which is called from the
	 * synchronous path that builds the "no credentials" error. Reading the same
	 * file through a second implementation there would let the error message and
	 * the interface disagree about what is configured, which is exactly the kind
	 * of difference that gets reported as "the key I saved does not work".
	 */
	storedProviderIds(): ReadonlySet<string> {
		return new Set(Object.keys(readLenient(this.path)));
	}

	/**
	 * Serialized read-modify-write.
	 *
	 * Returning `undefined` from `fn` leaves the entry alone, matching pi's
	 * contract — an OAuth refresh that decides it has nothing to do must not be
	 * indistinguishable from a logout.
	 */
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const data = readStrict(this.path);
		const current = data[providerId];
		const next = await fn(current);
		if (next === undefined) return current;
		data[providerId] = next;
		writeAuthFile(this.path, data);
		return next;
	}

	async delete(providerId: string): Promise<void> {
		const data = readStrict(this.path);
		if (!(providerId in data)) return;
		delete data[providerId];
		writeAuthFile(this.path, data);
	}
}

let shared: FileCredentialStore | undefined;

/**
 * The process-wide store.
 *
 * Cached because `ModelRuntime.create()` is called per session, and a fresh
 * store per session would mean a session could not see a key saved during the
 * previous one without a restart.
 */
export function credentialStore(): FileCredentialStore {
	shared ??= new FileCredentialStore();
	return shared;
}

/** Every provider id pi knows, so a typo is rejected instead of stored. */
function knownProviderIds(): ReadonlySet<string> {
	return new Set(builtinProviders().map((provider) => provider.id));
}

/**
 * One provider's state, as the interface needs it.
 *
 * Note what is absent: the key. `hint` is the last few characters, which is
 * enough for a person to tell two keys apart and useless to anyone else.
 */
export interface ProviderCredential {
	providerId: string;
	label: string;
	envVar: string;
	/** Where a usable credential comes from, if one exists. */
	source?: "stored" | "environment";
	hint?: string;
	models: readonly string[];
	defaultModel: string;
}

/** Last four characters, with the rest replaced. Never returns a whole key. */
function maskKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length <= 4) return "•".repeat(trimmed.length);
	return `${"•".repeat(8)}${trimmed.slice(-4)}`;
}

/**
 * Credential state for every provider we surface, in preset order.
 *
 * Also covers providers with no preset that happen to have a stored credential,
 * so a key installed by hand is visible rather than invisible-but-working — the
 * state that generates the worst bug reports.
 *
 * `store` is a seam for tests, which must not read or write the real
 * `auth.json`. Callers in the application take the default.
 */
export async function providerCredentials(
	env: NodeJS.ProcessEnv = process.env,
	store: CredentialStore = credentialStore(),
): Promise<ProviderCredential[]> {
	const stored = await store.list();

	const rows: ProviderCredential[] = [];
	for (const preset of PROVIDER_PRESETS) {
		const credential = await store.read(preset.id);
		const fromEnv = env[preset.envVar];
		const hasEnv = typeof fromEnv === "string" && fromEnv.trim().length > 0;
		// Only api_key credentials have a hint. An OAuth credential's access
		// token is not something a person recognises, so it shows as configured
		// and nothing more.
		const key = credential?.type === "api_key" ? credential.key : undefined;
		const row: ProviderCredential = {
			providerId: preset.id,
			label: preset.label,
			envVar: preset.envVar,
			models: preset.models,
			defaultModel: preset.defaultModel,
		};
		if (key) {
			row.source = "stored";
			row.hint = maskKey(key);
		} else if (credential) {
			row.source = "stored";
		} else if (hasEnv) {
			row.source = "environment";
			row.hint = maskKey(fromEnv);
		}
		rows.push(row);
	}

	const presetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
	for (const info of stored) {
		if (presetIds.has(info.providerId)) continue;
		const credential = await store.read(info.providerId);
		const row: ProviderCredential = {
			providerId: info.providerId,
			label: info.providerId,
			envVar: "",
			source: "stored",
			models: [],
			defaultModel: "",
		};
		if (credential?.type === "api_key" && credential.key) row.hint = maskKey(credential.key);
		rows.push(row);
	}

	return rows;
}

/**
 * Store an API key.
 *
 * Trimmed, because a key pasted from a terminal or a chat window routinely
 * arrives with a trailing newline, and a key with a newline in it fails at
 * request time with an authentication error that names nothing.
 */
export async function setApiKey(
	providerId: string,
	key: string,
	store: CredentialStore = credentialStore(),
): Promise<void> {
	const trimmed = key.trim();
	if (trimmed.length === 0) throw new Error("An API key cannot be empty.");
	if (!knownProviderIds().has(providerId)) {
		// Rejecting an unknown id matters more than it looks: a typo would
		// otherwise be stored happily and never used, which reads to the user as
		// "the key I saved does not work".
		throw new Error(`Unknown provider: ${providerId}. It is not one of the providers pi can talk to.`);
	}
	const credential: ApiKeyCredential = { type: "api_key", key: trimmed };
	await store.modify(providerId, async () => credential);
}

/** Remove a stored key. Does not touch a key that came from the environment. */
export async function removeApiKey(providerId: string, store: CredentialStore = credentialStore()): Promise<void> {
	await store.delete(providerId);
}
