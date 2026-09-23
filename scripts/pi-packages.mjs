/**
 * The pi packages this project vendors.
 *
 * Shared by the vendoring script and the path generator so the two cannot
 * disagree about what is present — a mismatch would produce a tsconfig pointing
 * at files that were never copied, which fails at build time with a confusing
 * error rather than at the point of the mistake.
 *
 * This is the dependency closure of our entry points, not every package
 * upstream ships. `client`, `protocol` and `server` are absent because only
 * `coding-agent/src/experimental/**` and `client/index.ts` reach them, and
 * nothing we import reaches those.
 */
export const PI_PACKAGES = ["ai", "agent", "tui", "coding-agent", "chord", "telemetry"];
