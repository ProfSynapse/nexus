---
name: nexus-mobile-compat
description: Keep Nexus loading on mobile and compliant with the Obsidian plugin store — vet a dependency, import without crashing init, confine a vault path, and prove none of it regressed with the reachability checker. Use before adding an npm package or a Node import, when writing to caller-supplied vault paths, when gating a desktop-only feature, when a PDF or worker-backed feature misbehaves, or when the plugin fails to load on a phone.
---

# Nexus mobile & plugin-store safety

Nexus ships `isDesktopOnly: false`, so `main.js` runs on phones with no Node.js.
The defect this skill exists to prevent has no compiler, no type, and no CI gate
behind it: a static import executes during module init, *before* any
`Platform.isDesktop` check, so one import on the startup path takes the plugin
down at launch on every phone — from a diff that looks unrelated.

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
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py .
   ```
   It walks static imports from `src/main.ts`, follows no `await import()`, and
   exits non-zero when a Node built-in is reachable from init. Run
   `--help` for `--trace <file>` (is this module on the startup path, and via
   what chain) and `--packages` (which npm packages init loads).
3. `npm run lint` catches the store rules that are mechanical, and `npm run
   build` runs it first. A green lint says nothing about reachability, and a
   green checker says nothing about the store rules. Run both.
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
- `scripts/check_mobile_imports.py` the import-graph checker. Run it; do not
  reimplement it as a grep — grep cannot see reachability, and this repo has
  known-correct hits that a grep reports as violations.

## Boundaries

The full store guidance lives in docs/obsidian-plugin-guidelines.md; this skill
is the part that bites in practice. Test lanes, the in-app Obsidian CLI loop and
mock-versus-real questions belong to `nexus-testing`. Storage roots, the event
store and migrations belong to `nexus-storage`. Release packaging belongs to
`nexus-release`.
