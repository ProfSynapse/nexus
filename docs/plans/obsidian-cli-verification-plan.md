# In-App Verification via the Obsidian CLI — Design Plan

**Status:** Design / pre-architecture
**Date:** 2026-08-14
**Author:** design discussion (ProfSynapse + Claude)
**Prompted by:** review of `kepano/obsidian-skills` (`skills/obsidian-cli`)

## 1. Goal

Make "does this actually work in Obsidian?" a question a script can answer.

Today it is answerable only by a human opening the app, which is why so much
work in this repo sits in a state described as *verified by unit tests and build
only*, and why "don't commit until manually tested" is a standing constraint.
The suite can be green while the plugin is broken in the app, and nothing
automated can tell the difference.

## 2. What changed

Obsidian shipped an official CLI that drives a **running** instance: early
access in 1.12.0, generally available in **1.12.4** (Feb 2026). It includes
developer commands, which is the part that matters here:

```bash
obsidian plugin:reload id=nexus          # pick up a fresh build
obsidian dev:errors                      # errors since load
obsidian dev:console level=error         # console output
obsidian dev:screenshot path=shot.png    # visual check
obsidian dev:dom selector=".x" text      # assert rendered DOM
obsidian dev:css selector=".x" prop=color
obsidian dev:mobile on                   # mobile emulation (see §6)
obsidian eval code="app.plugins.plugins.nexus…"   # run JS in app context
```

Our plugin id is `nexus` (`manifest.json:2`). The app must be running; the first
command launches it if not.

## 3. Mental model

> **We already accepted this argument once.**

`tests/debug/search-ranking-live-smoke.test.ts` exists because three ranking
defects (#309, #313, #314) shipped past a green unit suite, and every one was
caught by searching a real vault. Its header states the reason plainly: the unit
suite can only prove the tiers are ordered consistently with a *mocked* scorer.

That test drives **our CLI against a real vault**. The Obsidian CLI extends the
same idea one layer out — **our plugin inside the real app** — and closes the
same class of gap: everything that only exists once the plugin is loaded,
rendered and hydrated.

## 4. Deliverables

### 4.1 `scripts/verify-in-obsidian.mjs` + `npm run verify:obsidian`

The core loop, exiting non-zero on failure so anything can gate on it:

1. `npm run build`
2. `obsidian plugin:reload id=nexus`
3. `obsidian dev:errors` → fail if non-empty
4. `obsidian dev:screenshot path=test-artifacts/verify-<ts>.png`

Preconditions are detected and reported, never crashed on: `obsidian` on PATH,
version ≥ 1.12.4, an instance running, desktop only. When unavailable it exits 0
with a notice, so CI is unaffected. Sits alongside the existing `scripts/*.mjs`
conventions (`build-cli.mjs`, `smoke-google-live.mjs`).

### 4.2 `tests/debug/obsidian-live-smoke.test.ts`, gated `RUN_OBSIDIAN_SMOKE=1`

Mirrors the existing live-smoke lane exactly: env-gated, `--runInBand`, scratch
folder it cleans up, a header explaining why mocks cannot cover it. Uses
`obsidian eval` to invoke a Nexus tool in-app and assert on the result, then
`dev:errors` to prove nothing threw.

**Scenario selection criterion — the narrow part.** Only things that *cannot* be
observed outside the running app earn a scenario here. Anything a unit test can
reach stays a unit test. That points at three families:

| Family | Why only in-app | Example failure this catches |
|---|---|---|
| Lifecycle | Needs a real vault and a real load | Plugin fails to initialise on an installed build |
| Rendering | The pipeline can be right and the paint wrong | Reasoning flowed through every layer and never rendered; caught by eye |
| Cold cache / hydration | Ordering only exists at real startup | A board reading before its data source was ready |

The first scenario should be whichever of these is currently costing the most
manual checking — worth confirming against what is actually open at build time
rather than picking from an older test plan.

### 4.3 A `/nexus-verify` skill

Wraps the loop (build → reload → errors → screenshot → report) so an **agent**
can self-verify. This is the deliverable that changes the working agreement:
"don't commit until tested" becomes something an agent can satisfy rather than
block on. Lives beside the existing `.claude/skills/nexus-*` skills.

### 4.4 Pre-release gate in `/nexus-release`

Run `verify:obsidian` against the built artifact before tagging. Cheap, and it
covers the class of defect that has shipped before — a build that passes tests
and then misbehaves on a real vault at startup.

## 5. Phasing

| Phase | Content | Gate |
|---|---|---|
| 0 | Confirm local Obsidian ≥ 1.12.4 and `obsidian help` responds | Prerequisite; everything else is blocked on it |
| 1 | `verify-in-obsidian.mjs` + npm script, run by hand once | Reload + errors + screenshot work end to end |
| 2 | Smoke lane with one scenario | Fails when deliberately broken, passes when fixed |
| 3 | `/nexus-verify` skill | An agent completes the loop unattended |
| 4 | Wire into `/nexus-release` | Release blocked on a clean in-app load |

Phase 2's gate matters more than it sounds: a smoke test that has never failed
has not been shown to work.

### 5.1 Implementation status (2026-08-14)

| Deliverable | State |
|---|---|
| §4.1 `scripts/verify-in-obsidian.mjs` + `npm run verify:obsidian` | **Built.** Preconditions covered by `tests/unit/verifyInObsidianScript.test.ts` |
| §4.2 `tests/debug/obsidian-live-smoke.test.ts` | Not built |
| §4.3 `/nexus-verify` skill | Not built — the manual loop lives in `nexus-testing`'s `live-loop.md`, and `headless-obsidian.md` covers standing up an instance where there is none |
| §4.4 Pre-release gate | **Built.** `nexus-release`'s `cut-release.md` step 8 calls it before the tag |

Phase 0 turned out not to be a hard prerequisite: the script treats a missing,
too-old or unreachable Obsidian as a *skip* (exit 0 with a notice), so it is safe
in CI and on a contributor's machine without the app. Only `--require-obsidian`
turns those into failures.

## 6. Honest limitation — this does NOT cover mobile crashes

`dev:mobile on` emulates the mobile *environment*: `Platform.isMobile`, touch,
layout. It does **not** remove Node built-ins from Electron. The specific mobile
failure CLAUDE.md warns about — a top-level `import … from 'fs'`, or an npm
package with Node transitive deps, killing plugin init — will **not** reproduce
under emulation, because `require('fs')` still resolves there.

Use `dev:mobile` for UI and platform-branch coverage. Keep the static
import-guard lint (issue #221) as the actual mobile-compat defence, and do not
let a green `dev:mobile` run be read as "mobile-safe".

## 7. Risks and constraints

| Risk | Mitigation |
|---|---|
| `obsidian eval` runs arbitrary JS against the user's live vault | Target a scratch vault via `vault=<name>`; confine writes to a fixture folder; clean up in `finally`, as the search smoke test does |
| Local-only — needs a running desktop instance | Env-gated and skip-clean, exactly like the existing live-smoke lanes; never a CI dependency |
| Screenshot diffing invites flakiness | Screenshots are **artifacts for a human**, not assertions. Assert via `dev:dom`/`dev:errors` only |
| CLI output format changes between Obsidian versions | Parse defensively; treat unparseable output as "unknown", not "pass" |
| A stale build reloading silently | Reload only after a successful build in the same script run |

## 8. Open questions

1. Which scenario is worth automating first (§4.2)?
2. Should `/nexus-verify` run the full build or an incremental `npm run dev`
   output? Full build is slower but is what release actually ships.
3. Is a dedicated test vault worth checking in as a fixture, or does that drift
   from real-vault conditions — the very thing this lane exists to test?

## 9. Implementation reuse map (DRY)

| Need | Reuse |
|---|---|
| Env-gated live lane, scratch-and-clean discipline | `tests/debug/search-ranking-live-smoke.test.ts` |
| Node script conventions | `scripts/smoke-google-live.mjs`, `scripts/build-cli.mjs` |
| Skill layout | `.claude/skills/nexus-*` |
| Release gating | `/nexus-release` skill |
| Plugin id | `manifest.json:2` (`nexus`) |
