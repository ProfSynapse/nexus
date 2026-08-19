# Release machinery

Why the release protocol is shaped the way it is. Everything here is derived from
four files in the repo; each section names the command that re-derives it, so this
reference can be checked rather than trusted.

## Where the version lives

Four files carry it. Three are enforced, one drifts silently.

| File | Written by | Enforced by CI |
|---|---|---|
| `package.json` | `npm version` | yes — must equal the tag |
| `manifest.json` | `version-bump.mjs` | yes — must equal the tag |
| `versions.json` | `version-bump.mjs` | yes — must contain an entry keyed by the tag |
| `package-lock.json` | `npm version` | no |

Re-derive: `grep -n '"version"' package.json manifest.json package-lock.json`.

`version-bump.mjs` is invoked by the `version` npm lifecycle script. It reads
`npm_package_version` from the environment, writes it into `manifest.json` and
appends `"<version>": "<minAppVersion from manifest.json>"` to `versions.json`,
then regenerates the versioned CLI and MCP schema catalogs.
It is current and correct; use it rather than editing those two files.

One wrinkle, verified by running it: it writes `versions.json` with tabs (which
is how the file is stored) but `manifest.json` with two spaces, while the
committed `manifest.json` is tab-indented. Every bump therefore reindents
`manifest.json` and produces a whole-file diff. Cosmetic, and not worth
hand-reverting — the next bump would redo it. `../scripts/check_release_ready.py`
deliberately does not check `manifest.json` indentation for this reason.

Verified behaviour: `npm version <bump> --no-git-tag-version` still runs the
`version` lifecycle script, so it produces the full four-file bump without
creating npm's own tag. That matters because npm's default `tag-version-prefix`
is `v`, and a `v`-prefixed tag does not match the workflow trigger.

`package-lock.json` is the one nobody notices. It has been observed several
releases behind `package.json` in this repo, and releases still shipped — `npm ci`
tolerates a root-version-only mismatch. It is a warning in
`../scripts/check_release_ready.py`, not an error, for exactly that reason.

## What the workflow does

Read it: `cat .github/workflows/release.yml`.

- **Trigger.** `on: push: tags:` with a bare three-part number pattern — no `v`,
  no prerelease suffix. GitHub filter patterns must match the whole ref name, so
  anything else produces no run and no error.
- **Guard.** A `Validate version metadata` step compares the tag against
  `manifest.json` and `package.json`, and asserts `versions.json` has an entry
  keyed by the tag, and requires a matching schema manifest entry.
  `../scripts/check_release_ready.py` reproduces these as errors.
- **Build.** `npm ci` then `npm run build`, from the tagged commit, on a pinned
  Node version.
- **Publish.** The release name is set from the tag ref, so the title is always
  the bare number — there is no manual naming step and nothing to get wrong.
  Release notes are auto-generated. Uploaded assets are the plugin files plus
  the release's CLI and MCP catalogs.
- **Attest.** A build-provenance attestation is generated for those three assets.
  This is the reason releases must come from the workflow: a hand-made release
  has no attestation and one cannot be added afterwards.

## What the workflow does NOT guard

- **Tests.** No Jest step exists in the workflow. Nothing checks the suite.
- **`package-lock.json`.** Not compared to `package.json`.
- **`minAppVersion` correctness.** The guard only checks that a `versions.json`
  key exists, never that its value matches `manifest.json`.
- **Documentation.** Nothing reads `README.md`, `<repo>/guide/` or the changelog.
- **Whether generated sources were committed.** See below.

Each of these is a warning in `../scripts/check_release_ready.py` or a step in
`../protocols/cut-release.md`, because the workflow will not catch them for you.

## The build-order asymmetry

Read it: `grep '"build"' package.json`.

The build chain runs, in order: lint → build the CLI bundle →
`generate-cli-content.mjs` → `tsc --noEmit` → **esbuild production** →
compile the connector → `generate-connector-content.mjs`.

Two generated TypeScript sources are committed to `src/utils/`, and their position
relative to the bundling step decides whether a stale copy can ship:

- **`src/utils/cliAssets.ts`** is regenerated *before* esbuild. CI rewrites it
  from the freshly built CLI, `<repo>/skill/SKILL.md` and the playbooks, so the bundle
  always embeds current content regardless of what was committed. A stale
  committed copy is a repo-hygiene problem, not a release defect.
- **`src/utils/connectorContent.ts`** is regenerated *after* esbuild. The bundle
  therefore embeds the version that was **committed at the tag**. If `connector.ts`
  changed and this file was not regenerated and committed, the release ships the
  previous connector to every user who runs the Claude Desktop setup flow.

So the file to check before committing is `connectorContent.ts`. Both are marked
"DO NOT EDIT MANUALLY" in their headers — regenerate via `npm run build`, never by
hand.

## The tool catalog

`<repo>/schemas/manifest.json` points at versioned CLI and MCP catalogs generated from
the live registries. The repo-root JSON files are current-version compatibility
aliases. Two tests read the CLI alias: the shipped-guidance gate validates every
documented command against it, and `tests/unit/ToolManagerCliSyntax.test.ts`
asserts it has not drifted from the live registry. A release that adds, renames or
removes a tool must refresh it — the version lifecycle does so automatically,
and `npm run schemas:check` prevents a stale bundle from building.
