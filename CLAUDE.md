# agent-daemon

Discord-to-`pi`-coding-agent bridge daemon. Published npm package (`agent-daemon`, GitHub `Trex-Hub/pi-daemon`) — has a real `bin` entrypoint and CI publish pipeline, not just a local script. Keep that in mind before any change to the build/packaging story.

## Stack

- **TypeScript/Node, npm** (`"type": "module"`, ESM). Node >=18.
- **TypeScript 6**, compiled via `tsc` to `dist/` — this is a real build step, unlike a `tsx`-run project. `npm run build` / `npm run watch` / `npm run typecheck` (`tsc --noEmit`).
- **vitest** as the test runner, tests colocated as `src/*.test.ts` next to the source they cover — not a separate `tests/` mirror dir.
- **Biome** for lint (`biome.jsonc`). Run it directly (`./node_modules/.bin/biome check *.ts src`) — the `npx`/`rtk` wrapper has a known false-positive issue in this repo, don't trust its output.
- **pm2** manages the running daemon process; `src/cli.ts` wraps `pm2` via `spawnSync`, it isn't a pm2 API integration.
- **discord.js** for the Discord gateway, **croner** for cron scheduling.
- No path aliases — relative imports with explicit `.js` extensions (ESM/NodeNext resolution: `import { x } from "./state.js"` even though the source file is `state.ts`).

## Architecture

- `index.ts` (repo root) is the daemon entrypoint pm2 runs (`dist/index.js`). Boots state (`migrateState()` then `loadState()`), wires `DiscordTransport` → `GatewayAuth` → `SessionManager`/`StreamRouter`, then starts the cron scheduler. This is the one place Discord-specific `deliverTo` strings get interpreted for cron job results — `src/cron.ts` itself knows nothing about Discord.
- `src/state.ts` — `GatewayState`/`GatewayConfig`/`AuthState` shape + `state.json` persistence (`~/.pi/agent/gateway/state.json`). `loadState()` is a pure read (defaults-merge, never writes). `migrateState()` is the explicit, separate side-effecting step that backfills and persists new default fields into an old `state.json` — call it once at boot, before `loadState()`. Don't fold the two back together — read vs. mutate/persist are different responsibilities even when one function is the only call site.
- `src/auth.ts` — `GatewayAuth`: challenge-code onboarding (DM a 6-digit code) + 3-tier channel auth (`all`/`mentions`/`trusted-only`), plus the DM-only admin command set (`/enable`, `/disable`, `/enable-guild`, `/disable-guild`, `/revoke`, `/trusted`, `/channels`, `/guilds`, `/help`). The four scope-mutating commands share `enableScope`/`disableScope` — adding a new scope means a new call site with a label/suffix, not a new duplicated block.
- `src/discord.ts` — `DiscordTransport`: connection lifecycle, message/interaction handling, sending (plain messages, typing, confirm-prompt buttons). Anchor-card rendering (`AnchorState`, `AnchorHandle`, `buildAnchorContainer`, `chunkMessage`) lives in `src/anchor.ts` — a separate rendering concern from the transport itself.
- `src/streaming.ts` — `StreamRouter`: turns one channel's streamed `pi --mode rpc` NDJSON events into a throttled-edit anchor card plus a lazily-created thread carrying the tool-call log.
- `src/session.ts` — `SessionManager`: one persistent `pi --mode rpc` child process per channel, idle-reaped on an interval.
- `src/routing.ts` — channel↔directory mapping under `config.projectsRoot`, with path-escape protection (`resolveUnderRoot`).
- `src/cron.ts` + `src/cron-config.ts` — Discord-free one-shot `pi -p` cron engine (`cron-jobs.json`), validated on load; bad job entries are skipped with a logged reason, never block boot.
- `src/cli.ts` — the `agent-daemon` bin: `start|stop|restart|status|logs|install|update`, mostly a thin pm2 wrapper plus `install` (interactive `state.json` setup) and `update` (`npm install -g agent-daemon@latest`, re-reads `package.json` after to report the new version).

## Code style

- `type` over `interface` for object shapes — no declaration merging is used anywhere in this repo, so there's no reason to reach for `interface`.
- Arrow functions over `function` declarations for module-level functions (`const foo = () => {}`). Class methods stay normal method syntax — this rule is about top-level functions, not methods.
- Collapse repeated near-identical blocks into a data-driven table/shared function once you see 3+ copies (see `enableScope`/`disableScope` in `src/auth.ts`) — don't leave copy-pasted command handlers as the steady state.
- Split a file when it's grown multiple real concerns, not on a strict line count — `src/anchor.ts` split out of `src/discord.ts` because anchor-card rendering isn't the transport's job, not because of a line-count threshold.
- Minimal comments — only when the *why* isn't obvious from the code (a non-obvious invariant, a workaround, a subtlety a reader would trip on). Don't restate what the code already says.

## Git

- Commit messages explain *why*, not just *what*.
- No `Co-Authored-By` trailer.
- One release = one version bump commit (see `package.json` history) — semantic versioning, minor bump per feature release.

## Release

`prepublishOnly` runs `clean && typecheck && test && build` before `npm publish`. `.github/workflows/publish.yml` triggers on `release: published` and publishes using the `NPM_TOKEN` secret. So the release flow is: bump `package.json` version → commit → tag → `gh release create` → CI does the rest. Don't hand-run `npm publish` locally.
