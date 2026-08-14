# Changelog conventions

`<repo>/docs/changelog.md` is the one file under `docs/` that is part of a
release. Its conventions are not documented anywhere else; they are read off the
file itself. Re-derive with `head -40 docs/changelog.md`.

## Structure

- A single `# Nexus Changelog` title.
- `## <Month> <Year>` sections, newest first.
- Inside a section, one block per version, newest first, separated by a `---`
  horizontal rule.
- Each block opens with a bolded version and an em-dashed headline:
  `**vX.Y.Z** — <one-line summary of what changed for the user>`.
- Longer releases group their bullets under bolded sub-headings (a short phrase,
  not a heading level).
- Bullets are prose sentences, not commit subjects.
- References to work link inline: `([#123](https://github.com/ProfSynapse/nexus/pull/123))`
  for a PR, or the `issues` URL for an issue.

Note the asymmetry: the changelog heading carries a `v` prefix, the git tag never
does. Copying the heading into `git tag` is a real way to produce a tag that
triggers nothing.

## Voice

Write what changed for the person using Nexus, not what changed in the code. The
existing entries are the style guide:

- Lead with the observable outcome, then the mechanism if it helps.
- Name the symptom the user actually hit, including the wrong behaviour they saw.
- Say plainly when a change will look like a regression but is not — e.g. a
  status that flips from "working" to "not configured" because the old status was
  lying.
- Avoid internal class names, file paths and refactor vocabulary. A bullet that
  only makes sense to someone who read the diff belongs in the PR, not here.

## Placement

The entry goes in before the tag. It is not generated: the workflow's
auto-generated GitHub release notes come from commit titles and are a separate,
coarser artifact — the changelog is the curated one.

`../scripts/check_release_ready.py` warns when the changelog has no entry for the
version being released. It cannot judge whether the entry is *good*; that is the
reviewer's job, using this file.
