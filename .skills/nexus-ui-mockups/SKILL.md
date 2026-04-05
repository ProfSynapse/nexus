---
name: nexus-ui-mockups
description: Create or update standalone UI mockups for Nexus before implementation. Use when the user asks for a new view, modal, workflow, layout refactor, or other substantial UX change that should be reviewed in `docs/mockups/` before production code.
---

# Nexus UI Mockups

Use this skill when the task is primarily about shaping or reviewing UX before implementation.

## When to Use This Skill

Use it when the user:
- Wants a new screen, panel, modal, toolbar, board, or flow
- Is redesigning an existing UI surface
- Wants to explore interaction options before wiring real plugin state
- Asks for a mockup, prototype, preview, or design artifact

Skip it for tiny visual tweaks unless a mockup would materially reduce implementation risk.

## Output Location

Create mockups in `docs/mockups/`.

Default file shape:
- `docs/mockups/<feature-name>.html`
- `docs/mockups/<feature-name>.css`
- `docs/mockups/<feature-name>.js`

For very small previews, a single self-contained HTML file is acceptable.

## Required Pattern

1. Build the mockup first, before editing production UI code, when the UX is still being defined.
2. Keep it standalone. No framework, bundler, or app bootstrapping.
3. Use realistic Nexus copy and sample data. Do not use placeholder lorem ipsum unless the exact text is irrelevant.
4. Match the product's visual language with CSS custom properties and Obsidian-style tokens.
5. Show the important states and interactions:
   - empty/loading/error when relevant
   - hover/focus/selected states when relevant
   - in-memory interaction simulation for drag/drop, filters, editors, or other flows
6. If the mock simulates persistence, say so plainly in the UI copy, for example "updated in this mock".
7. After the mockup is accepted, implement the real UI separately under `src/` and move production styling into `styles.css`.

## Repo References

- `docs/mockups/task-board-view.html` is the reference for larger interactive mockups with separate CSS and JS files.
- `docs/mockups/compaction-indicator-preview.html` is the reference for small focused previews.

## Guardrails

- Do not wire mockups into the plugin runtime unless the user explicitly asks for that.
- Do not treat mockup-only inline CSS or local event listeners as permission to use those patterns in production plugin code.
- Keep filenames descriptive and kebab-case.
- Prefer sample data that resembles real workspaces, tasks, conversations, or settings from this repo.
