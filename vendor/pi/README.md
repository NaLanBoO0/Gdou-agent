# Vendored pi source

pi is vendored into this repository rather than consumed as a dependency. This
directory holds a verbatim copy of the packages this project uses.

`manifest.json` is the machine-readable record: the exact source checkout, the
vendoring date, the per-package versions, and a sha256 for every file.

| package | version | why it is here |
|---|---|---|
| `ai` | 0.86.1 | provider APIs, model registry, auth, streaming |
| `agent` | 0.86.1 | the agent loop, tool definitions, session primitives |
| `tui` | 0.86.1 | terminal rendering used by the TUI front-end |
| `coding-agent` | 0.86.1 | the built-in tool set (bash, read, edit, write, grep, ...) |
| `chord` | 0.86.1 | bundling helper `coding-agent` depends on |
| `telemetry` | 0.86.1 | no-op telemetry interface used by `ai` and `agent` |

The tree was copied on 2026-09-22 and contains 701 files.

## This tree is read-only

Upstream code stays byte-identical. `npm run check:vendor` verifies every file
against the manifest and fails on any missing, added, or modified file.

To change behaviour, put the change in `src/` — wrap it, configure it, or
substitute it at one of the seams pi exposes (`streamFn`, `transformContext`,
`beforeToolCall`/`afterToolCall`, `prepareNextTurn`, profiles, custom tools).
Patching here means the next upgrade silently reverts you, and the diff stops
being reviewable.

If a change genuinely belongs upstream, re-vendor deliberately and commit the
result as its own reviewable change:

```
npm run vendor:pi -- --from <path to a pi checkout>
npm run sync-paths
```

## What is not here, and why

- **`client`, `protocol`, `server`** — only referenced from
  `coding-agent/src/experimental/**`, which this project does not use. Copying
  them would add three packages and their transitive closure for dead code.
- **`durable`, `evals`, `session-backends`, `agent-old`** — not imported by the
  closure above. `agent-old` in particular is a superseded implementation.
- **Each package's `package.json`** — omitted on purpose, and this one matters.
  pi locates its own state directory by walking up from its module location to
  the nearest `package.json` and reading `piConfig` from it. If pi's
  `package.json` were present, that walk would stop on pi's, and a development
  run would resolve its state directory to `~/.pi/agent` — downloading ripgrep
  into pi's directory and quietly breaking the isolation this project promises.
  With the files absent, the walk passes through `vendor/` and lands on this
  project's `package.json`. `scripts/pi-env.mjs` pins the same thing explicitly
  as a guard against a future re-vendor reintroducing the files.
- **`dist/`** — pi is source-only; there is no build output to copy.
- **Tests, examples, fixtures** — not needed to build or run.

## External dependencies are not vendored

The source here imports third-party packages (`typebox`, `openai`, `chalk`,
`yaml`, ...). Those live in this project's `node_modules`, declared in
`package.json` at exactly the versions pi pins — a vendored copy of pi's source
only resolves if those versions match. Upgrading pi means reconciling that list
too; the script does not do it for you.

## How the imports resolve

pi's published `exports` point at `./dist/*`, which does not exist here, so bare
imports like `@earendil-works/pi-ai` would fail. `npm run sync-paths` reads the
vendored `tsconfig.json`, rewrites each mapping to point into
`vendor/pi/packages/*/src`, and writes `tsconfig.pi-paths.json`. Both `tsx` (at
runtime) and `esbuild` (at build time) honour it, so one mapping serves both and
there is no build step between editing pi's source and running it.

`tsconfig.pi-paths.json` is generated. Edit `scripts/sync-pi-paths.mjs`, not it.

## License

pi is MIT licensed. The upstream `LICENSE` is copied here as `LICENSE` and
applies to everything in this directory.
