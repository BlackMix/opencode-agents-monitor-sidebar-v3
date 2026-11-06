# AGENTS.md

OpenCode TUI plugin that renders an Agents sidebar. The entire plugin is one TypeScript/TSX file (`src/index.tsx`) using Solid.js with the `@opentui/solid` renderer. This repo has **no tests, no lint, no CI, and no tsconfig** — do not invent those workflows.

## Commands

- Install dependencies: `bun install` (bun is the package manager; no lockfile is committed, versions float within `^` ranges).
- Build the plugin entry: `bun install` then `bun run build` (writes `dist/index.js` via `script/build.mjs` — the Solid JSX transform from `@opentui/solid/bun-plugin`, runtime specifiers kept external). There are no tests, no lint, no typecheck script; `bun x tsc --noEmit` won't work without a tsconfig. Verification is manual (below).
- Regenerate logo assets after touching them: `node script/logo.mjs` (writes `assets/logo-dark.svg`, `assets/logo-light.svg`).

## Manual verification (the only test path)

1. Point the global `~/.config/opencode/cli.json` at this checkout:

   ```json
   {
     "plugins": ["/absolute/path/to/opencode-agents-monitor"]
   }
   ```

   OpenCode v2 reads TUI plugins only from `cli.json`; `tui.json` is not used.

2. Run `bun run build` after changing `src/index.tsx`. The root `tui.js` re-exports `dist/index.js`, so a local checkout path resolves the compiled entry.
3. Reload the TUI (`/reload`) and press `ctrl+x`, then `b` to show the sidebar. Check that the Agents widget renders and updates.

## Architecture notes

- Package entrypoint is `package.json` `exports["./tui"]` → `dist/index.js`; the root `tui.js` re-exports it for local-path loading.
- The default plugin id is `agents-sidebar`, and it registers in the `sidebar.content` slot.
- Widget state lives in a `createTracker()` created via `createRoot` *outside* the slot component tree (`src/index.tsx`) so slot re-renders don't reset it. Preserve this structure.
- The tracker anchors on the root session (`context.data.session.root`), renders the root as the `primary` row, and lists every descendant session as a sub-agent, indented by depth.
- Live status comes from `context.data.session.status`; message data is hydrated lazily for completed agents.
- The `history` checkbox is persisted in the `agents_sidebar` storage entry and hides completed sessions by default.

## Gotchas

- Keep the `/** @jsxImportSource @opentui/solid */` pragma at line 1 — the JSX transform depends on it.
- Plugin id `agents-sidebar` intentionally differs from the npm package name; do not rename the id.
- Code uses ES2023 `Array.prototype.findLast` and bare `catch {}` (deliberate API-error swallowing). Keep a modern runtime; don't "clean up" the empty catches.
- `README.md` (EN) and `README.zh-CN.md` (中文) must stay in sync when editing docs.
- The published `./tui` export MUST be a compiled ESM file (`dist/index.js`, with `"type": "module"`) — never raw `src/index.tsx`. The host's Solid JSX transform excludes `node_modules` paths, so a TSX entry inside the installed package is silently dropped at load.
- Keep `@opentui/solid*` and `solid-js*` bare imports external. The host rewrites them to its bundled runtime modules at load; `script/build.mjs` bakes the runtime module ids (`opentui:runtime-module:<encoded-spec>`) into the output at build time because the host's rewrite regex needs whitespace after `from`/`import`.
- When testing a package install, patch the cached copy under `~/.cache/opencode/npm/` or reinstall the plugin after publishing. Do not commit `node_modules`.
