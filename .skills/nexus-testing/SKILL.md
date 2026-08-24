---
name: nexus-testing
description: Verify a Nexus change — pick a Jest lane, write a test that can actually fail, run the in-app Obsidian CLI loop, drive the eval harness, or fix a shipped-docs drift failure. Use when adding or changing tests, when a mock might be deciding the outcome, when a change has to be proven in the running plugin, or when the guidance gate fails.
---

# Testing Nexus

Context: every Jest lane resolves `obsidian` to a hand-written mock — see
`moduleNameMapper` in jest.config.js. A green suite therefore proves the code
agrees with `tests/mocks/obsidian/`, not with Obsidian. Three ranking defects
shipped past that suite. Everything below exists to close the gap between what
Jest can prove and what the running plugin does.

## Workflow

1. Pick the job and open its protocol. Work from the protocol, not from this
   router — the router names procedures, it does not contain them.

   | Job | Protocol |
   |---|---|
   | Add or change a test | `protocols/write-a-test.md` |
   | Prove a change works in the running plugin | `protocols/live-loop.md` |
   | No Obsidian here (container / cloud session) | `protocols/headless-obsidian.md` |
   | Run a gated live-smoke lane or the eval harness | `protocols/run-gated-lanes.md` |
   | `shippedGuidanceCommands` or `ToolManagerCliSyntax` is red | `protocols/fix-shipped-docs-drift.md` |
   | A symptom you cannot place | `references/troubleshooting.md` |

2. Derive every list from the tree, never from a document. This skill states no
   test counts, no lane inventory and no env-var table on purpose, and you MUST
   NOT add one — those rot silently and a rotted list is worse than none.
   `references/lanes.md` holds the discovery commands.

3. Before calling a testing change done, run both checks from the repo root and
   fix anything they print:

   ```bash
   python3 .claude/skills/nexus-testing/scripts/check_live_lane_gates.py
   python3 .claude/skills/nexus-testing/scripts/check_catalog_target.py
   ```

4. NEVER claim a change is verified in the app on the strength of Jest alone.
   If the change touches load order, rendering, hydration or anything that only
   exists once the plugin is running, `protocols/live-loop.md` is the proof and
   nothing else is.

5. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map

- `protocols/` the procedures: write-a-test, live-loop, headless-obsidian,
  run-gated-lanes, fix-shipped-docs-drift, self-refine.
- `references/` read on demand: `lanes.md` (where a test goes and how to find
  what exists), `mock-honesty.md` (the two habits that make a test able to fail),
  `troubleshooting.md` (symptom → cause).
- `scripts/` the mechanical checks named in step 3. Run them; do not
  reimplement them.
- `refinement-log.md` what past sessions changed here and why.

## Siblings — do not duplicate them here

- `nexus-eval-harness` — configuring, extending and debugging the eval harness.
  This skill covers only running it and the two knobs that surprise people.
- `nexus-model-eval` — grading specific models.
- `nexus-tool-schemas` — regenerating the tool catalog (no running vault needed).
- `nexus-agents` — the two-tool contract and the `useTools` payload shape a test
  has to build.
- `nexus-mobile-compat` — the mobile failure class the in-app loop cannot see.
- `nexus-storage` — resetting persisted state when a plugin reload is not enough.

## Status of the in-app loop

**Exercised 2026-08-14** against Obsidian 1.13.7 in a headless Linux container
and **2026-08-21** against Obsidian 1.12.7 on macOS. Setup, vault-targeted
`plugin:reload`, `dev:errors`, `dev:console`, `dev:screenshot`, `dev:debug`, and
synchronous `eval` are confirmed working. The first run found a startup-ordering
bug that every Jest lane was blind to; the macOS run confirmed explicit
`vault=<name>` targeting and clean repeated reloads.
