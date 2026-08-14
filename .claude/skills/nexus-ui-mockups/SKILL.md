---
name: nexus-ui-mockups
description: Design a Nexus UI change as a standalone mockup under docs/mockups/ before any production code, then hand it off as the visual contract a plan implements against. Use when asked for a new view, panel, modal, settings tab, chat surface, or layout refactor, when revising or superseding an existing mockup, or when a plan needs something visual to be blessed against.
---

# Nexus UI Mockups

Context: a mockup is a standalone HTML/CSS/JS page in `docs/mockups/` that shows
a proposed Nexus surface before the plugin code exists. It is worth building only
if it looks like the real product and promises only what the plugin can actually
render; otherwise it is a drawing that costs a rewrite later. This router points
at the procedures — the detail loads when you take the path.

## Workflow
1. Decide the artifact. A new or substantially reshaped surface gets a mockup
   first. A tweak inside an existing layout does not — say so and implement.
2. New mockup: follow `protocols/build-mockup.md` step by step.
3. Existing mockup to change, supersede, or retire: follow
   `protocols/revise-mockup.md` first — you MUST NOT overwrite a mockup a plan
   already cites as its visual contract.
4. Before showing anyone: run `python3 .claude/skills/nexus-ui-mockups/scripts/check_mockup.py`
   from the repo root and fix every error it prints. Nothing else in the repo
   checks mockups — `eslint` and the build both ignore `docs/`.
5. Implementation is a separate job under `src/`, governed by CLAUDE.md's hard
   rules and the sibling skills (`nexus-mobile-compat` for phone and plugin-store
   constraints, `nexus-agents` for tools behind the UI, `nexus-testing` for
   proving it in the running plugin). Mockup-only liberties never travel there.

## Map
- `references/fidelity.md` — how to make it look like Obsidian and like Nexus:
  the token block, both themes, production class naming, icons, phone widths.
- `references/honest-mockups.md` — keeping the mockup buildable: Obsidian form
  primitives, labelling simulation, flagging what will not ship as drawn.
- `references/handoff.md` — serving it, review, blessing it as a plan's visual
  contract, and what happens to it after the UI ships.
- `protocols/` — `build-mockup.md`, `revise-mockup.md`, `self-refine.md`.
- `scripts/` — `check_mockup.py` (validate a mockup), `theme_tokens.py` (extract
  the token set production actually relies on). Run them, do not reimplement.

## Refine
At the end of a session that used this skill, run `protocols/self-refine.md`.
