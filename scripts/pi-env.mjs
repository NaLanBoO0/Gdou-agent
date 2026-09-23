/**
 * Preloaded by the development scripts to pin pi's package directory.
 *
 * pi decides where its own state lives by walking up from its module location
 * until it finds a `package.json`, then reading `piConfig` from it. The bundle
 * has no problem with this: it sits under this project's root, so the walk
 * lands on this package and picks up the `piConfig` block.
 *
 * Vendoring pi changed this from a necessity to a guard. pi's sources now live
 * at `vendor/pi/packages/*\/src`, and we deliberately do not vendor a
 * `package.json` for them (see vendor/pi/README.md), so the upward walk passes
 * through `vendor/` and lands on this project's package.json on its own.
 *
 * The pin is kept anyway: it costs nothing, and it keeps dev runs correct even
 * if someone re-vendors with a checkout that does carry package.json files, or
 * moves the tree. Without it, that regression is silent — pi would resolve its
 * state directory to `~/.pi/agent` and download ripgrep into pi's directory,
 * quietly breaking the isolation this project promises. The symptom is not an
 * error, just files appearing somewhere they should not be.
 *
 * `PI_PACKAGE_DIR` is pi's documented override for exactly this. It has to be
 * set before pi's config module is evaluated, so this runs as a preload
 * (`node --import`) instead of relying on import order inside the entry points.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `??=` so an explicit override from the environment still wins.
process.env.PI_PACKAGE_DIR ??= resolve(dirname(fileURLToPath(import.meta.url)), "..");
