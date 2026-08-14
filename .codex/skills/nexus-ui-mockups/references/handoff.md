# Handoff: serving, blessing, and the life of a mockup after it ships

Context: read once a mockup is built, and again when its surface has shipped. It
covers how the mockup gets looked at, how it becomes a contract, and what happens
to the file afterward.

## Key idea
In this repo a mockup is not a sketch that gets thrown away — it becomes the
visual contract a plan implements against, and it keeps being cited after the UI
ships. That makes serving it and citing it correctly part of the job, and it
makes a deleted or silently rewritten mockup a source of dead references.

## Serving it
The repo ships a static server for `docs/mockups/`. From the repo root:

    node scripts/serve-mockups.mjs <feature-name>.html

It serves that directory on `127.0.0.1:4173` (override with the `PORT`
environment variable) and maps `/` to the entry file you passed. It resolves
`docs/mockups` relative to the working directory, so it only works from the repo
root, and it refuses paths that escape that directory. A single-file preview also
opens fine over `file://`; anything with companion `.css`/`.js` is better served.

Include the URL when you hand the mockup to the user, and note which states the
`mock-` chrome can switch between so they know what to click.

## Review
Iterate in the mockup, never in `src/` — the point of the artifact is that
changing it is cheap. Take the user's feedback in rounds: apply it, re-run
`check_mockup.py`, tell them what changed. When they accept it, say plainly that
the mockup is now the reference for implementation, so the acceptance is explicit
rather than assumed.

## Blessing it as a contract
A blessed mockup gets cited from the plan in `docs/plans/` that implements it —
by path, with the version and the date it was accepted. Downstream, exact copy
strings from the mockup can be lifted into tests as constants, which is how a
shipped feature in this repo kept its empty-state and confirmation copy honest.
Two consequences:

- Cite the mockup **by file**, and cite behavior **through the plan**. Never
  reference a mockup by line number from production code or from a test.
- Once cited, the file is load-bearing. Changing it goes through
  `../protocols/revise-mockup.md`.

## After the UI ships
Both outcomes are legitimate; what matters is that nothing is left pointing at
something that moved:

- **Keep it** when a plan names it as the visual contract, or when the design has
  versions worth comparing. Superseded versions live alongside the original as
  suffixed files rather than overwriting it.
- **Retire it** when the surface has shipped, nobody cites it, and the file would
  only mislead the next reader. Delete it *and* the references to it in the same
  change.

The failure mode to avoid is already in the tree: several comments in
`styles.css` explain a production rule as "ported from" a mockup class at a
specific mockup line number, and that mockup no longer exists anywhere in the
repo. The comments now point at nothing, and the line numbers could not have been
trusted even while the file lived. If production code needs to record where a
design came from, name the plan or the feature — not a mockup file and never a
line number.

## Lookup
- Plan format and existing plans: `docs/plans/` (the format to follow, per
  CLAUDE.md).
- Server implementation, if the behavior above ever seems wrong:
  `scripts/serve-mockups.mjs`.
- Release history, when a shipped surface needs dating: the changelog in `docs/`.
