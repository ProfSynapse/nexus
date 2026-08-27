# Protocol: cut-release

Context: the end-to-end procedure for shipping a Nexus version. The tag is the
only thing you publish; `<repo>/.github/workflows/release.yml` does the rest from
the tagged commit. Read `../references/release-machinery.md` if any step's
reasoning is unclear — this protocol states what to do, that reference states why.

## Mission
Produce a correct commit on `main` and a bare `X.Y.Z` tag on it, such that the
release workflow runs green and publishes the plugin plus schema assets with
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
`versions.json`, then regenerates the release's CLI and MCP schema catalogs.

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
npm ci
npm run build
```
`npm ci` first, because the workflow runs `npm ci` — a local `node_modules` that
has drifted from `package-lock.json` can build green here and still fail on the
tagged commit (it broke the 5.16.0 tag). `npm run build` is then the same command
the workflow runs, so it is your CI parity check — and
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

Then verify the built artifact **in a running Obsidian**, which no Jest lane can
do — every lane resolves `obsidian` to a hand-written mock, so a green suite says
nothing about whether the plugin still loads in the app:

```bash
npm run verify:obsidian -- --skip-build --vault <your test vault>
```

`--skip-build` reuses the bundle step 6 just produced. It reloads the plugin,
fails on a non-empty `dev:errors`, and drops a screenshot in `test-artifacts/`.

Read its last line before moving on. It exits **0 in two different situations**,
and they are not the same result:

| Output | Meaning |
|---|---|
| `VERIFIED in the running app` | the plugin loaded and `dev:errors` was clean |
| `SKIPPED — …` | no Obsidian here (or too old, or not running). **Nothing was verified.** |

A `SKIPPED` is not a blocker — releasing from a machine without Obsidian is
still fine, which is why this step cannot fail for you — but it does mean this
class of defect is unguarded for that release, and a startup defect is exactly
what has shipped past a green suite before. If you have Obsidian, make it say
VERIFIED.

The vault it reloads is whatever build is installed in that vault's
`.obsidian/plugins/nexus/`. Unless that folder is a symlink to this checkout, run
your deploy step first or you have verified an older bundle.

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
never rename it); assets are `main.js`, `manifest.json`, `styles.css`,
`cli-tools.json`, and `mcp-tools.json` (still no `connector.js`); notes were
auto-generated; the attestation step succeeded.

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
- Anti-pattern: reading only the exit code of `npm run verify:obsidian`. It exits
  0 both when it verified the app and when it found no Obsidian to verify
  against; only the last line distinguishes them.

## Next
Release verified → `self-refine.md`. Release broken → `recover.md`.
