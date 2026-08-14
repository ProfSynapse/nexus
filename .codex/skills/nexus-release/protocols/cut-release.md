# Protocol: cut-release

Context: the end-to-end procedure for shipping a Nexus version. The tag is the
only thing you publish; `<repo>/.github/workflows/release.yml` does the rest from
the tagged commit. Read `../references/release-machinery.md` if any step's
reasoning is unclear — this protocol states what to do, that reference states why.

## Mission
Produce a correct commit on `main` and a bare `X.Y.Z` tag on it, such that the
release workflow runs green and publishes the three plugin assets with
attestation.

## Steps

### 1. Establish the starting state
Release only from `main`. Confirm, and stop if any of these is not true:

```bash
git branch --show-current      # must be main
git pull --ff-only origin main # must succeed
git status --porcelain         # must be empty, or only changes you intend to ship
```

Do not release from a feature branch, and do not carry unrelated working-tree
changes into the version commit.

### 2. Decide the bump
Ask the user if they did not say. Patch for fixes and small improvements, minor
for new non-breaking features, major for breaking changes. Do not infer the level
from the commit count.

### 3. Bring user-facing docs in line
Run `doc-review.md`, then return here. A release that ships a feature nobody
documented is the most common defect this protocol prevents, and reading prose
does not catch renamed tools — that protocol ends in a mechanical check.

### 4. Write or verify the changelog entry
`<repo>/docs/changelog.md` needs an entry for the new version before the tag.
Conventions and voice: `../references/changelog-format.md`. If the entry already
exists, verify it against what actually merged rather than assuming.

### 5. Bump the version with the repo's own machinery
```bash
npm version <patch|minor|major> --no-git-tag-version
```
This bumps `package.json` and `package-lock.json`, then runs the repo's `version`
lifecycle script (`version-bump.mjs`), which writes the new version into
`manifest.json` and appends the `version -> minAppVersion` entry to
`versions.json`.

Expect `manifest.json` to come back reindented from tabs to two spaces — the
bump script rewrites it that way. The whole-file diff is cosmetic and harmless;
do not hand-revert it, or the next bump churns it again.

- `--no-git-tag-version` is REQUIRED. Without it npm creates its own tag, and
  npm's default `tag-version-prefix` is `v` — a `v5.9.1` tag does not match the
  workflow's tag filter and the release silently never runs.
- Do NOT hand-edit `manifest.json` or `versions.json`. Hand-editing is how the
  lockfile version drifted from `package.json` in this repo, and how a
  `versions.json` entry gets forgotten — which the workflow guard rejects.
- Only raise `minAppVersion` in `manifest.json` if the release genuinely requires
  a newer Obsidian. Bump it *before* this step so the new `versions.json` entry
  picks up the right value.

### 6. Rebuild
```bash
npm run build
```
This is the same command the workflow runs, so it is your CI parity check — and
it is what refreshes the generated sources. It lints, builds the CLI, regenerates
`src/utils/cliAssets.ts`, type-checks, bundles, compiles the connector and
regenerates `src/utils/connectorContent.ts`. A failure here is a failure that
would otherwise take down the release *after* the tag exists.

CI pins an exact Node version, which may not be the one you have locally:

```bash
grep -A4 'setup-node' .github/workflows/release.yml
```

If yours differs, treat a green local build as necessary but not sufficient.

### 7. Stage everything the build regenerated
```bash
git status
```
`git status` is the authority — stage what it lists, do not work from a
memorised file list. The one that changes what ships is
`src/utils/connectorContent.ts`: it is regenerated *after* the bundle is built,
so the bundle embeds whatever was committed. Leave it stale and the release ships
the previous connector. See `../references/release-machinery.md` for why
`src/utils/cliAssets.ts` behaves differently.

### 8. Run the tests that gate the release
The release workflow runs **no tests at all**. Nothing but you stands between a
broken suite and a published tag.

```bash
npx jest tests/unit/shippedGuidanceCommands.test.ts   # always
npm test                                              # for anything non-trivial
```

### 9. Commit and push
```bash
git add <the files from step 7>
git commit -m "chore: bump version to X.Y.Z"
git push origin main
```
The build outputs themselves (`main.js`, `connector.js`, `nexus-cli.js`, the
WASM binary) are gitignored and are never committed — CI rebuilds them. What you
are committing is the version bump, the docs and the generated `src/utils/`
sources. Confirm the push landed before tagging. The workflow builds the tagged commit
from the remote; a tag on an unpushed commit cannot be resolved.

### 10. Run the readiness check — it MUST exit clean
```bash
python3 .claude/skills/nexus-release/scripts/check_release_ready.py --tag X.Y.Z
```
Errors reproduce the workflow's own guard: a non-zero exit here is the workflow
failing, minutes earlier and for free. Warnings are drift the workflow tolerates
(lockfile version, `minAppVersion` mismatch, missing changelog entry) — read them
and decide, do not skip them.

### 11. Tag and push the tag
```bash
git tag X.Y.Z
git push origin X.Y.Z
```
Bare `X.Y.Z`. No `v`, no suffix. The workflow's tag filter matches nothing else,
and a non-matching tag produces no error anywhere — just silence.

### 12. Verify the published release
Watch the run, then check the release page:

```bash
gh run watch --exit-status   # or: gh run list --workflow=release.yml
gh release view X.Y.Z
```

Confirm: the release name is exactly `X.Y.Z` (the workflow sets it from the tag —
never rename it); assets are exactly `main.js`, `manifest.json`, `styles.css` and
nothing else (no `connector.js`); notes were auto-generated; the attestation step
succeeded.

Anything wrong → `recover.md`.

## Guidelines
- Pattern: everything that must be in the release goes in *before* step 11. The
  tag is a snapshot, not a pointer that follows `main`.
- Pattern: prefer the repo's own scripts over hand edits. They exist, they are
  current, and they touch every file a hand edit forgets.
- Anti-pattern: `npm version` without `--no-git-tag-version`, then wondering why
  no workflow ran.
- Anti-pattern: building the assets locally and uploading them to a
  hand-made release. That skips provenance attestation and is not recoverable
  by editing the release afterwards.
- Anti-pattern: treating a green `npm run build` as proof the suite passes. The
  build does not run Jest and neither does the workflow.

## Next
Release verified → `self-refine.md`. Release broken → `recover.md`.
