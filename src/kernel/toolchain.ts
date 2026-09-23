/**
 * Where pi's coding tools keep their state and their managed binaries, and how
 * those binaries get there.
 *
 * `grep` and `find` do not implement search themselves: they shell out to
 * ripgrep and fd, which pi downloads on first use. That download goes into a
 * directory pi owns, derived from pi's own package metadata rather than from
 * anything this project sets.
 *
 * Two consequences are worth the code below.
 *
 * First, the location is easy to get wrong and the failure is silent. If it
 * resolves somewhere unexpected the tools pollute another application's state;
 * nothing errors, files just appear in the wrong place. `toolchainPaths()`
 * exists so the answer is inspectable, and the GUI check asserts it.
 *
 * Second, a download cannot be relied on. On a machine without internet the
 * tools end up quietly broken — the user sees "search returns nothing", not an
 * error. So the installer ships the binaries and `provisionManagedBinaries()`
 * puts them where pi looks before it would consider downloading. pi checks its
 * own bin directory first, so a provisioned binary means no network is needed.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, getBinDir, getToolsDir } from "@earendil-works/pi-coding-agent/config.ts";

export interface ToolchainPaths {
	/** The directory pi treats as its own state root. */
	agentDir: string;
	/** Where ripgrep and fd are downloaded to and executed from. */
	binDir: string;
	/** Where user-supplied tool extensions are loaded from. */
	toolsDir: string;
}

export function toolchainPaths(): ToolchainPaths {
	return {
		agentDir: getAgentDir(),
		binDir: getBinDir(),
		toolsDir: getToolsDir(),
	};
}

/** The managed binaries, named as they appear on this platform. */
export const MANAGED_BINARIES = ["rg", "fd"] as const;

export interface ProvisionReport {
	/** Copied into place on this call. */
	copied: string[];
	/** Already present, left untouched. */
	present: string[];
	/** Not in the source directory, so still subject to a download. */
	missing: string[];
	/** Failures, reported rather than thrown: provisioning must not block startup. */
	errors: string[];
}

function binaryFileName(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Copy the shipped binaries into the directory pi searches.
 *
 * Deliberately best-effort. Provisioning is an optimisation over pi's own
 * download, so a failure here degrades to the previous behaviour rather than
 * stopping the app from starting. Existing files are never overwritten: if pi
 * has already fetched a newer build, that one wins.
 */
export function provisionManagedBinaries(sourceDir: string): ProvisionReport {
	const report: ProvisionReport = { copied: [], present: [], missing: [], errors: [] };
	const binDir = getBinDir();

	for (const name of MANAGED_BINARIES) {
		const fileName = binaryFileName(name);
		const target = join(binDir, fileName);

		if (existsSync(target)) {
			report.present.push(name);
			continue;
		}

		const source = join(sourceDir, fileName);
		if (!existsSync(source)) {
			report.missing.push(name);
			continue;
		}

		try {
			mkdirSync(binDir, { recursive: true });
			copyFileSync(source, target);
			report.copied.push(name);
		} catch (error) {
			report.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return report;
}
