---
name: nexus-release
description: Cut a Nexus release — bump the version with the repo's own machinery, get the docs and generated sources right, push a tag the GitHub Actions workflow will actually pick up, and recover when it does not. Use when asked to release, publish, ship, cut a release, bump the version, or tag a version, and when a release workflow did not fire, failed its version guard, or produced the wrong assets.
---

# Nexus Release

Context: a Nexus release is one artifact — a **bare `X.Y.Z` git tag on `main`**.
Everything downstream (installing, building, naming the release, uploading
`main.js` / `manifest.json` / `styles.css`, provenance attestation) is done by
`<repo>/.github/workflows/release.yml` from the tagged commit. You never build
the release; you make the tagged commit correct and then tag it.

Two consequences shape everything here. The tag is the point of no return — the
workflow reads the tree *as committed at that tag*. And the workflow guards only
three things, so everything else is on you.

Path convention: `<repo>/…` means relative to the Nexus repo root. Bare paths
(`protocols/…`, `scripts/…`) are inside this skill.

## Workflow

1. **Cutting a release** → follow `protocols/cut-release.md` end to end, in
   order. Do not improvise the sequence: several steps only have any effect
   *before* the tag exists.
2. **Bringing user-facing docs in line** (a phase of the above; also runnable on
   its own) → `protocols/doc-review.md`.
3. **Before pushing any tag** you MUST get a clean exit from the readiness
   check. It reproduces the workflow's own version guard locally, so a failure
   here is a failure you would otherwise discover *after* the tag exists:

   ```bash
   python3 .claude/skills/nexus-release/scripts/check_release_ready.py --tag X.Y.Z
   ```

   (`--repo` defaults to the repo root found by walking up from the working
   directory. Run `--help` for the flags; stdlib only, no `node_modules`. If the
   mirror above is absent, the same file is at
   `<repo>/.skills/nexus-release/scripts/check_release_ready.py`.)
4. **The workflow did not run, failed its guard, or shipped the wrong assets** →
   `protocols/recover.md`. NEVER hand-create a release or hand-attach assets to
   fix it — that silently drops provenance attestation.
5. **After a release session** → `protocols/self-refine.md`.

## Map

- `protocols/` the how: `cut-release.md`, `doc-review.md`, `recover.md`,
  `self-refine.md`.
- `references/` the why, read on demand: `release-machinery.md` (what the
  workflow really does, what it guards, what it does not, and the build-order
  asymmetry that decides which generated file can ship stale),
  `changelog-format.md` (the conventions the changelog actually follows).
- `scripts/` `check_release_ready.py` — version consistency across
  `package.json`, `manifest.json`, `versions.json`, the lockfile and the tag.
- `refinement-log.md` — what past releases taught this skill.

## Siblings

Do not duplicate these; call them.

| Need | Skill |
|---|---|
| Regenerate the tool catalog a release must ship current | `nexus-tool-schemas` |
| Choose a Jest lane, or debug a failing guidance/drift test | `nexus-testing` |
| Provider/model metadata that a release happens to include | `nexus-model-updates` |
| Mobile or plugin-store compliance of what is being shipped | `nexus-mobile-compat` |

## Editing this skill

`<repo>/.skills/` is the source of truth for this skill; `.claude/skills/`,
`.codex/skills/` and `.cline/skills/` are mirrors written by
`npm run sync:skills`. Edit the copy under `<repo>/.skills/nexus-release/` and
re-run the sync. The mirror copy overwrites changed files but does not delete
extra ones, so editing a mirror leaves a half-reverted hybrid on the next sync.
