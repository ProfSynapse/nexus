---
name: nexus-mobile-compat
description: Keep Nexus loading on mobile and compliant with the Obsidian plugin store — vet a dependency, import without crashing init, confine a vault path, and prove none of it regressed with the reachability checker. Use before adding an npm package or a Node import, when writing to caller-supplied vault paths, when gating a desktop-only feature, when a PDF or worker-backed feature misbehaves, or when the plugin fails to load on a phone.
---

# Nexus mobile & plugin-store safety

Nexus ships `isDesktopOnly: false`, so `main.js` runs on phones with no Node.js.
The defect this skill exists to prevent has no compiler and no type behind it: a
static import executes during module init, *before* any `Platform.isDesktop`
check, so one import on the startup path takes the plugin down at launch on every
phone — from a diff that looks unrelated.

The reachability checker below is now wired into the repo's own gate: `npm run
lint` runs `lint:obsidian` (ESLint) then `lint:mobile` (this checker), and `npm
run build` runs `npm run lint` first. A violation fails the build. Run the
checker directly anyway while you work — the gate is the floor, not the loop.

## Workflow

Pick the row that matches the job and follow that protocol. Do not improvise from
this page; each protocol carries the steps and the checks.

| Situation | Protocol |
|---|---|
| Adding or upgrading an npm package | `protocols/vet-a-dependency.md` |
| Need a Node built-in, a heavy module, or a desktop-only feature | `protocols/import-without-crashing.md` |
| Writing, reading or deleting at a caller-supplied vault path | `protocols/confine-a-vault-path.md` |
| About to ship a change that touched imports or the startup path | `protocols/verify-mobile-safety.md` |
| "It won't load on my phone" / a mobile-only failure | `protocols/diagnose-mobile-crash.md` |
| Session that used this skill is ending | `protocols/self-refine.md` |

1. Read the protocol the table names, in full, before editing anything.
2. Whatever the protocol, you MUST run the reachability checker before calling
   the change done — it is the only guard for this defect class:
   ```bash
   node scripts/check-mobile-imports.mjs .
   # identical, the way the build invokes it:
   npm run lint:mobile
   ```
   `scripts/check-mobile-imports.mjs` in the repo IS the checker — one
   implementation, edit it there. It was a Python script behind a launcher until
   2026-08-15, when Obsidian's community scorecard failed build verification on a
   clean container that has Node but no Python. A build gate may only depend on
   what the build already needs.

   It walks static imports from `src/main.ts`, follows no `await import()`, and
   exits non-zero when a Node built-in is reachable from init. Run
   `--help` for `--trace <file>` (is this module on the startup path, and via
   what chain) and `--packages` (which npm packages init loads).
3. `npm run lint` now runs both halves: ESLint for the store rules that are
   mechanical, then the reachability checker. A green ESLint says nothing about
   reachability, and a green checker says nothing about the store rules — which
   is why the composed script runs both, and why `npm run build` calls it.
   ESLint additionally hard-errors on Node built-in and Node-dependent package
   imports under `src/settings/components/**` (issue #221): those shared UI
   primitives are reachable from init today, but the per-file ban holds even if
   the import graph shifts. The blocklists are the `MOBILE_BANNED_*` arrays at
   the top of `eslint.config.mjs`; widen the guard by adding a glob to that
   block's `files`.
4. NEVER treat `obsidian dev:mobile on` as evidence of mobile safety. It emulates
   `Platform.isMobile`, touch and layout inside Electron, where `require('fs')`
   still resolves — this crash class cannot reproduce there. See
   `references/init-order.md`.

## Map

- `protocols/` the procedures above, each ending at the next one.
- `references/` read on demand: `init-order.md` (why a platform guard below an
  import is decoration, and what reachability really guarantees),
  `plugin-store-rules.md` (the store rules and which are already lint-enforced),
  `pdfjs-in-electron.md` (the worker constraint and the single sanctioned entry).
- The import-graph checker lives in the repo, not here:
  `scripts/check-mobile-imports.mjs`. Run it; do not reimplement it as a grep —
  grep cannot see reachability, and this repo has known-correct hits that a grep
  reports as violations.

## Boundaries

The full store guidance lives in docs/obsidian-plugin-guidelines.md; this skill
is the part that bites in practice. Test lanes, the in-app Obsidian CLI loop and
mock-versus-real questions belong to `nexus-testing`. Storage roots, the event
store and migrations belong to `nexus-storage`. Release packaging belongs to
`nexus-release`.
