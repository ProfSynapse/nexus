---
name: nexus-release
description: Version bump and GitHub Actions release for the Nexus Obsidian plugin. Use when the user wants to cut a release, bump the version, or publish a new version after stable changes are ready.
---

# Nexus Release

Handles version bumping and tag-driven GitHub release creation for the Nexus Obsidian plugin.

## When to Use This Skill

Use when the user:
- Asks to "release", "publish", "bump version", or "cut a release"
- Says changes are stable and ready to ship
- Asks about the release process

## Pre-Flight Checks

Before releasing, verify:
1. The release changes are merged into `main`
2. You are on `main`
3. `git pull --ff-only origin main` succeeds
4. No unrelated uncommitted changes are present
5. `npm run build` passes clean
6. Relevant tests pass

Do not release from a feature branch. Do not create a release manually from local build artifacts unless the tag workflow failed and the user explicitly approves a fallback.

## Documentation Review (before bumping)

A release often ships user-facing features whose docs were never updated. Before bumping the version, review what merged and bring the docs in line.

1. **See what landed since the last release:**

   ```bash
   git describe --tags --abbrev=0   # most recent release tag
   git log --no-merges --format='%h %s' <last-tag>..HEAD
   ```

2. **Identify user-facing changes** — new apps, new tools, new UI surfaces, changed behavior, new settings. Ignore internal refactors, type fixes, and test-only commits.

3. **Update only user-facing docs.** Scope is strictly **`README.md`** and the **`guide/`** folder (the README-linked canonical docs). **Never** touch anything under `docs/` — that tree (`docs/features/`, `AGENTS.md`, `TOOL_REFERENCE.md`, plans, reviews) is developer/internal material the maintainer manages separately. There is an orphaned `docs/features/` mirror of `guide/`; leave it alone.

   Common surfaces that need updating when features ship:
   - `guide/apps.md` — the **Available Apps** table (add new apps + their tools; mark desktop-only/experimental)
   - `README.md` — the **Use Cases** table and the **Mobile Support** table
   - `guide/task-management.md`, `guide/workspace-memory.md`, `guide/semantic-search.md`, etc. — feature-specific guides
   - When in doubt about exact tool names or enum values, confirm against `src/` rather than guessing.

4. **Confirm the changelog** (`docs/changelog.md`) has an entry for the new version — this one file under `docs/` IS part of the release and is usually already written; verify it exists and is accurate. If a doc update is large or uncertain, surface it to the user rather than guessing.

5. **Run the mechanical check — do not rely on reading alone.** Reviewing prose reliably misses renamed tools and stale flags; this guard parses every shipped example against the real catalog:

   ```bash
   npx jest tests/unit/shippedGuidanceCommands.test.ts
   ```

   It covers `README.md`, all of `guide/`, `skill/SKILL.md`, the playbooks, and the `nexus --help` text, checking: agent/tool/flag existence, playbook `tools:` frontmatter selectors, the `guide/apps.md` Apps table, embedded `--prompts` payloads, and relative doc links. A failure prints the file, line, offending command, and reason — **fix the doc, not the test.**

6. **If this release adds, renames, or removes a tool**, refresh the two inventories the check and future agents read, or they validate against stale truth:

   - `cli-first-tool-schemas.json` — regenerate via the `/nexus-tool-schemas` skill (needs a running vault). `tests/unit/ToolManagerCliSyntax.test.ts` carries a drift assertion that fails when this snapshot disagrees with the live registry, so a stale catalog surfaces there.
   - `CLAUDE.md` — the **Agent Architecture** tool lists and the **Tool Count** line. Write tool names in CLI form (`agent tool-name`, kebab-case) so they match what callers actually type, and confirm each against `src/agents/**` (`slug: '...'`) rather than copying the previous list forward. These lists feed every future agent session, so a stale entry propagates.

Commit doc updates to `main` (separately from, or together with, the version bump) before tagging, so the release reflects current docs.

## Release Steps

### 1. Determine Version Bump

Ask the user if not specified:
- **Patch** (x.x.+1): Bug fixes, compliance fixes, small improvements
- **Minor** (x.+1.0): New non-breaking features
- **Major** (+1.0.0): Breaking changes

For a post-review compliance release from `5.9.0`, default to `5.9.1` unless the user requests otherwise.

### 2. Bump Version in 4 Files

Do not use `npm version`; the repo has a stale `version` lifecycle script. Edit these files directly and keep all four in sync:

```text
package.json   -> "version": "X.Y.Z"
manifest.json  -> "version": "X.Y.Z"
CLAUDE.md      -> "- **Version**: X.Y.Z"
versions.json  -> add "X.Y.Z": "<minAppVersion from manifest.json>" (tab-indented)
```

The `versions.json` entry is mandatory: since 5.11.2, `release.yml` has a guard that fails the workflow if the tag, `manifest.json`, `package.json`, and `versions.json` disagree. Copy the `minAppVersion` value from `manifest.json` (do not bump it unless the release actually raises the minimum Obsidian version).

### 3. Rebuild

Rebuild after the version bump so generated release-adjacent content is current:

```bash
npm run build
```

Check the generated artifact sizes (macOS/Linux):

```bash
stat -f "%N %z" main.js manifest.json styles.css   # macOS
# or: ls -la main.js manifest.json styles.css
```

`main.js` should stay below 5 MB for Obsidian Sync Standard compatibility.

### 4. Commit and Push Main

Stage the version bump plus any generated content that the rebuild changed:

```bash
git add package.json manifest.json CLAUDE.md versions.json \
        src/utils/connectorContent.ts src/utils/cliAssets.ts
git commit -m "chore: bump version to X.Y.Z"
git push origin main
```

Both generated files are tracked and easy to miss. `src/utils/cliAssets.ts` embeds the bundled `nexus` CLI, `skill/SKILL.md`, and the playbooks, and is what `LocalCliInstaller` writes to disk — so if it is stale, users installing the CLI get the previous version's binary and guidance even though the release shipped a fix. Run `git status` after the rebuild and stage whatever it regenerated rather than trusting this list.

### 5. Create and Push the Release Tag

The GitHub Actions release workflow runs on version tags and creates the release.

```bash
git tag X.Y.Z
git push origin X.Y.Z
```

Release title rule: the GitHub release name must be the tag number only, with no `v` prefix and no descriptive suffix. Example: `5.9.1`.

### 6. Verify GitHub Actions Release

The `.github/workflows/release.yml` workflow must:
- Build from the tag in GitHub Actions
- Upload only the 3 Obsidian-supported release assets:
  - `main.js`
  - `manifest.json`
  - `styles.css`
- Generate artifact attestations for the uploaded assets

After the workflow completes, verify the GitHub release contains no unsupported files such as `connector.js`.

## Release Notes Template

GitHub Actions currently generates release notes automatically. If editing notes after the workflow creates the release, use this install text:

```markdown
## Install

Download `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/nexus/` folder. For Claude Desktop/MCP setup, enable Nexus in Obsidian and use Settings -> Get started -> MCP integration to create `connector.js`.
```

## Release Artifacts Checklist

| File | Purpose |
|------|---------|
| `main.js` | Plugin bundle (esbuild output) |
| `manifest.json` | Obsidian plugin manifest |
| `styles.css` | Plugin styles |

## Common Mistakes to Avoid

- Releasing from a feature branch instead of `main`
- Forgetting to pull latest `main` before the version bump
- Using `npm version`
- Forgetting to rebuild after the version bump
- Missing one of the 4 version files (`versions.json` is the easy one to forget — the release workflow guard will fail the build)
- Manually attaching unsupported release artifacts such as `connector.js`
- Manually creating a release in a way that bypasses artifact attestations
- Shipping new features without updating `README.md` / `guide/` docs
- Editing docs under `docs/` (developer/internal) — user-facing docs live only in `README.md` and `guide/`
- Treating the doc review as a read-through instead of running `tests/unit/shippedGuidanceCommands.test.ts` — renamed tools are invisible to skimming
- Leaving `src/utils/cliAssets.ts` (or `connectorContent.ts`) unstaged after the rebuild, shipping a stale embedded CLI
- Adding or renaming a tool without refreshing `cli-first-tool-schemas.json` and the `CLAUDE.md` tool lists — both feed later agent sessions
- Editing a skill under `.claude/skills/`, `.codex/skills/`, or `.cline/skills/` — those are **sync targets**. The source of truth is `.skills/`; edit there and run `npm run sync:skills`, or the next sync silently reverts the change
