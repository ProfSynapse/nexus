# Closing the manual-verification gap with the Obsidian CLI

Status: **proposed**
Date: 2026-08-14
Related: `tests/debug/*-live-smoke.test.ts`, `/nexus-release`, kepano/obsidian-skills
`skills/obsidian-cli`

## The gap this closes

Almost every recent entry in CLAUDE.md ends the same way: *"verified by unit
tests + build only — NOT yet manually tested in Obsidian"*, plus a standing
"do not commit until the user manually tests" constraint. The suite can be green
and the plugin still be broken in the app, and only a human at a keyboard can
currently tell the difference. Three shipped defects (v5.16.2 search ranking)
went past a green suite for exactly this reason.

Obsidian shipped an official CLI — early access in 1.12.0, generally available
in **1.12.4** (Feb 2026) — that drives a *running* Obsidian instance, including
developer commands. That turns "reload the plugin and check for errors" into
something a script (or an agent) can do unattended.

Relevant commands:

```bash
obsidian plugin:reload id=nexus          # pick up a fresh build
obsidian dev:errors                      # errors since load
obsidian dev:console level=error         # console output
obsidian dev:screenshot path=shot.png    # visual check
obsidian dev:dom selector=".x" text      # assert rendered DOM
obsidian dev:css selector=".x" prop=color
obsidian dev:mobile on                   # mobile emulation
obsidian eval code="app.plugins.plugins.nexus…"   # run JS in app context
```

Our plugin id is `nexus` (manifest.json:2).

## Deliverables

### 1. `scripts/verify-in-obsidian.mjs` + `npm run verify:obsidian`

The core loop, exiting non-zero on failure so it can gate anything:

1. `npm run build`
2. `obsidian plugin:reload id=nexus`
3. `obsidian dev:errors` → fail if non-empty
4. `obsidian dev:screenshot path=test-artifacts/verify-<ts>.png`

Preconditions to detect and report clearly rather than crash: `obsidian` on
PATH, Obsidian ≥ 1.12.4, an instance running, desktop only. Skip cleanly (exit
0 with a notice) when unavailable, so CI is unaffected.

### 2. `tests/debug/obsidian-live-smoke.test.ts`, gated `RUN_OBSIDIAN_SMOKE=1`

We already have this exact pattern: `search-ranking-live-smoke.test.ts` runs
under `RUN_SEARCH_SMOKE=1` and drives a real vault through the `nexus` CLI,
because mocked search hid three real ranking bugs. The Obsidian CLI extends the
pattern from "our CLI against a real vault" to "our plugin inside the real app":
use `obsidian eval` to invoke a Nexus tool in-app and assert on the result, then
`dev:errors` to prove nothing threw.

Highest-value first targets, all currently unautomatable:

- MCP socket connect on an installed build (an open item in the 5.11.1 manual
  test plan).
- Secure key storage round-trip (same).
- Chat view renders a streamed response — the reasoning-render gap shipped
  through every layer and was only caught by eye.
- Task board cold-start (the `waitForQueryReady` hydration race behind #267).

### 3. A `/nexus-verify` skill

Wraps the loop so an agent can self-verify: build → reload → errors → screenshot
→ report. This is what makes the "don't commit until tested" constraint
something an agent can satisfy rather than block on.

### 4. Pre-release gate in `/nexus-release`

Run `verify:obsidian` against the built artifact before tagging. Cheap, and it
would have caught the class of bug that shipped in 5.8.12/5.8.13.

## Honest limitation: this does NOT cover mobile crashes

`dev:mobile on` emulates the mobile *environment* — `Platform.isMobile`, touch,
layout. It does not remove Node built-ins from Electron. The mobile failure mode
CLAUDE.md warns about (a top-level `import ... from 'fs'` or an npm package with
Node transitive deps killing plugin init) will **not** reproduce under emulation,
because `require('fs')` still resolves there.

So: use `dev:mobile` for UI and platform-branch coverage, and keep the static
import-guard lint (issue #221) as the actual mobile-compat defence. Do not let a
green `dev:mobile` run be read as "mobile-safe".

## Other caveats

- Desktop-only, requires a running instance, and the user's real vault — this is
  a local developer loop, not CI.
- `obsidian eval` runs arbitrary JS in the app against the user's live vault.
  Smoke tests must target a scratch vault (`vault=<name>` targets a specific
  one), never the primary one, and must not write outside a fixture folder.
- Cannot be validated from a remote container — there is no Obsidian here. All
  of this needs a first run on the user's machine.

## Steps

1. Confirm the local Obsidian is ≥ 1.12.4 and `obsidian help` responds.
2. Land `verify-in-obsidian.mjs` + npm script; run it by hand once.
3. Add the smoke test lane with one scenario (MCP socket connect).
4. Add `/nexus-verify`; then wire into `/nexus-release`.
