---
name: nexus-release
description: Version bump and GitHub release for the Nexus Obsidian plugin. Use when the user wants to cut a release, bump the version, or publish a new version after stable changes are ready.
---

# Nexus Release

Handles version bumping and GitHub release creation for the Nexus Obsidian plugin.

## When to Use This Skill

Use when the user:
- Asks to "release", "publish", "bump version", or "cut a release"
- Says changes are stable and ready to ship
- Asks about the release process

## Pre-Flight Checks

Before releasing, verify:
1. `npm run build` passes clean (TypeScript + esbuild)
2. `npm run test` passes (if tests exist for changed code)
3. You are on `main` branch with all changes merged
4. No uncommitted changes (except what will be part of the version bump)

## Release Steps

### 1. Determine Version Bump

Ask the user if not specified:
- **Patch** (x.x.+1): Bug fixes, small improvements
- **Minor** (x.+1.0): New features, non-breaking changes
- **Major** (+1.0.0): Breaking changes

### 2. Bump Version in 4 Files

Update all four:
```
package.json      →  "version": "X.Y.Z"
manifest.json     →  "version": "X.Y.Z"
versions.json     →  add/update "X.Y.Z": "0.15.0"
CLAUDE.md         →  "- **Version**: X.Y.Z"
```

### 3. Rebuild

**CRITICAL**: Must rebuild after version bump so `connectorContent.ts` picks up the new version.

```bash
npm run build
```

### 4. Commit and Push

```bash
git add package.json manifest.json versions.json CLAUDE.md src/utils/connectorContent.ts
git commit -m "chore: bump version to X.Y.Z"
git push origin main
```

### 5. Create GitHub Release

Always attach the **4 build artifacts**:

Use a `vX.Y.Z` git tag, but a number-only GitHub release title:

```bash
gh release create vX.Y.Z \
  main.js connector.js manifest.json styles.css \
  --title "X.Y.Z — Short Description" \
  --notes "$(cat <<'EOF'
## What's New / Fixes

- **Feature/Fix name**: Description

## Install

Download `main.js`, `connector.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/nexus/` folder.
EOF
)"
```

### Release Artifacts Checklist

| File | Purpose |
|------|---------|
| `main.js` | Plugin bundle (esbuild output) |
| `connector.js` | MCP server connector |
| `manifest.json` | Obsidian plugin manifest |
| `styles.css` | Plugin styles |

## Common Mistakes to Avoid

- Forgetting to rebuild after version bump (stale `connectorContent.ts`)
- Missing one of the 4 version files (`versions.json` is required)
- Not attaching all 4 release artifacts
- Releasing from a feature branch instead of `main`
- Using `vX.Y.Z` in the release title instead of `X.Y.Z`
