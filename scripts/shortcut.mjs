/**
 * Point the desktop shortcut at the build in this project folder.
 *
 * Why this exists: installing with `npm run package` creates a shortcut that
 * points into `%LOCALAPPDATA%\Programs\...`. That is a snapshot from packaging
 * time, so it silently keeps launching an older build after the source moves on.
 * This writes a shortcut that points at `release/win-unpacked` instead, which
 * lives inside the project and is refreshed by `npm run package:dir`.
 *
 * Run with: node scripts/shortcut.mjs [--remove]
 *
 * The .lnk is written directly rather than through WScript.Shell: COM object
 * instantiation is blocked in some environments, and the format is small enough
 * to emit exactly.
 *
 * What is emitted, and why it is the minimal correct form:
 *
 *   - No TargetIDList. Windows normally stores the target a second time as a
 *     shell item list, encoded with 8.3 short names ("GDOU-A~1.EXE") and
 *     namespace GUIDs. That encoding needs the volume's short-name table, so it
 *     cannot be reproduced for an arbitrary path without asking the shell. It is
 *     optional: Windows falls back to LinkInfo, which carries the long path.
 *   - LinkInfo with VolumeIDAndLocalBasePath, so the long path is authoritative.
 *   - WorkingDir, so the app starts with the project folder as its cwd.
 *
 * `HeaderSize` is always 0x4C even though the trailing `Reserved3` field is only
 * defined when HasName is set; every real shortcut writes 76 bytes here.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(ROOT, "release", "win-unpacked", "GDOU-agent.exe");
const SHORTCUT_NAME = "Gdouwork.lnk";

/** The desktop can be redirected to OneDrive, so ask the shell where it is. */
function desktopDir() {
	try {
		const out = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders').Desktop",
			],
			{ encoding: "utf8" },
		);
		const path = out.trim();
		if (path) return path;
	} catch {
		// Fall through to the conventional location.
	}
	return join(process.env.USERPROFILE ?? "", "Desktop");
}

const CLSID = Buffer.from("0114020000000000c000000000000046", "hex");

/** A string in the StringData section: a uint16 character count, then the data. */
function stringData(value, unicode) {
	if (unicode) {
		const chars = Buffer.from(value, "utf16le");
		const header = Buffer.alloc(2);
		header.writeUInt16LE(chars.length / 2, 0);
		return Buffer.concat([header, chars]);
	}
	const chars = Buffer.from(value, "latin1");
	const header = Buffer.alloc(2);
	header.writeUInt16LE(chars.length, 0);
	return Buffer.concat([header, chars]);
}

function buildLink(target, workingDir) {
	const unicode = true;
	// NAME is the comment shown in a tooltip; WORKING_DIR sets the start
	// directory; ICON_LOCATION makes Explorer use the app's own icon.
	const flags = 0x2 /* HasLinkInfo */ | 0x4 /* HasName */ | 0x10 /* HasWorkingDir */ | 0x40 /* HasIconLocation */ | 0x80 /* IsUnicode */;

	// ------------------------------------------------------------------ header
	const header = Buffer.alloc(76);
	header.writeUInt32LE(0x4c, 0); // HeaderSize
	CLSID.copy(header, 4);
	header.writeUInt32LE(flags, 20);
	header.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE
	// CreationTime / AccessTime / WriteTime left as zero: "unspecified".
	header.writeUInt32LE(0, 52); // FileSize
	header.writeUInt32LE(0, 56); // IconIndex
	header.writeUInt32LE(1, 60); // ShowCommand = SW_SHOWNORMAL
	// HotKey, Reserved1, Reserved2, Reserved3 left as zero.

	// ---------------------------------------------------------------- LinkInfo
	const volumeLabel = Buffer.from("\0", "latin1");
	const volumeId = Buffer.alloc(16 + volumeLabel.length);
	volumeId.writeUInt32LE(volumeId.length, 0);
	volumeId.writeUInt32LE(3, 4); // DRIVE_FIXED
	volumeId.writeUInt32LE(0, 8); // volume serial, unused
	volumeId.writeUInt32LE(16, 12); // offset of the label within this struct
	volumeLabel.copy(volumeId, 16);

	const localBasePath = Buffer.from(`${target}\0`, "latin1");
	const suffix = Buffer.from("\0", "latin1");

	const headerSize = 0x1c;
	const volumeIdOffset = headerSize;
	const localBasePathOffset = volumeIdOffset + volumeId.length;
	const suffixOffset = localBasePathOffset + localBasePath.length;
	const linkInfoSize = suffixOffset + suffix.length;

	const linkInfo = Buffer.alloc(linkInfoSize);
	linkInfo.writeUInt32LE(linkInfoSize, 0);
	linkInfo.writeUInt32LE(headerSize, 4);
	linkInfo.writeUInt32LE(1, 8); // VolumeIDAndLocalBasePath
	linkInfo.writeUInt32LE(volumeIdOffset, 12);
	linkInfo.writeUInt32LE(localBasePathOffset, 16);
	linkInfo.writeUInt32LE(0, 20); // no CommonNetworkRelativeLink
	linkInfo.writeUInt32LE(suffixOffset, 24);
	volumeId.copy(linkInfo, volumeIdOffset);
	localBasePath.copy(linkInfo, localBasePathOffset);
	suffix.copy(linkInfo, suffixOffset);

	// -------------------------------------------------------------- StringData
	// Order is fixed by the format: NAME, RELATIVE_PATH, WORKING_DIR,
	// COMMAND_LINE_ARGUMENTS, ICON_LOCATION.
	const strings = Buffer.concat([
		stringData("Gdouwork - built from this project folder", unicode),
		stringData(workingDir, unicode),
		stringData(target, unicode),
	]);

	// ExtraData: a lone TerminalBlock, meaning "nothing further".
	const extraData = Buffer.alloc(4);

	return Buffer.concat([header, linkInfo, strings, extraData]);
}

function main() {
	const remove = process.argv.includes("--remove");
	const linkPath = join(desktopDir(), SHORTCUT_NAME);

	if (remove) {
		if (existsSync(linkPath)) {
			rmSync(linkPath);
			process.stdout.write(`removed ${linkPath}\n`);
		} else {
			process.stdout.write(`nothing to remove at ${linkPath}\n`);
		}
		return;
	}

	if (!existsSync(TARGET)) {
		throw new Error(`no packaged build at ${TARGET}\nrun: npm run package:dir`);
	}

	// Keep the previous shortcut recoverable rather than overwriting it blind.
	if (existsSync(linkPath)) {
		const backup = `${linkPath}.bak`;
		copyFileSync(linkPath, backup);
		process.stdout.write(`backed up existing shortcut to ${backup}\n`);
	}

	const link = buildLink(TARGET, dirname(TARGET));
	writeFileSync(linkPath, link);

	// Read it back so a malformed header is caught here rather than on the
	// user's next double-click.
	const written = readFileSync(linkPath);
	process.stdout.write(`wrote ${linkPath} (${written.length} bytes)\n`);
	process.stdout.write(`  target : ${TARGET}\n`);
	process.stdout.write(`  workdir: ${dirname(TARGET)}\n`);
	process.stdout.write(`  header : 0x${written.readUInt32LE(0).toString(16)}\n`);
}

main();
