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

## Release Steps

### 1. Determine Version Bump

Ask the user if not specified:
- **Patch** (x.x.+1): Bug fixes, compliance fixes, small improvements
- **Minor** (x.+1.0): New non-breaking features
- **Major** (+1.0.0): Breaking changes

For a post-review compliance release from `5.9.0`, default to `5.9.1` unless the user requests otherwise.

### 2. Bump Version in 3 Files

Do not use `npm version`; the repo has a stale `version` lifecycle script. Edit these files directly and keep all three in sync:

```text
package.json   -> "version": "X.Y.Z"
manifest.json  -> "version": "X.Y.Z"
CLAUDE.md      -> "- **Version**: X.Y.Z"
```

### 3. Rebuild

Rebuild after the version bump so generated release-adjacent content is current:

```bash
npm run build
```

Check the generated artifact sizes:

```bash
Get-Item main.js,manifest.json,styles.css | Select-Object Name,Length
```

`main.js` should stay below 5 MB for Obsidian Sync Standard compatibility.

### 4. Commit and Push Main

Stage only the version bump and release workflow changes:

```bash
git add package.json manifest.json CLAUDE.md .github/workflows/release.yml
git commit -m "chore: bump version to X.Y.Z"
git push origin main
```

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
- Missing one of the 3 version files
- Manually attaching unsupported release artifacts such as `connector.js`
- Manually creating a release in a way that bypasses artifact attestations
