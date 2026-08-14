# Protocol: recover

Context: the tag has been pushed and something is wrong — no workflow ran, the
run failed, or the published release is not what it should be. The tagged commit
is immutable in practice; recovery means producing a correct commit and moving
the tag to it, not editing the release.

## Mission
Get a correct release published by the workflow, with attestation intact, and
without leaving a misleading tag or half-release behind.

## Steps

### 1. Determine whether anything ran at all
```bash
gh run list --workflow=release.yml --limit 5
```
No run for your tag means the tag never matched the trigger — go to step 2. A run
that started and failed means the guard or the build rejected it — go to step 3.

### 2. No run: fix the tag shape
The workflow triggers only on tags matching the pattern in the `on: push: tags:`
block of `<repo>/.github/workflows/release.yml`, which is a bare three-part
number. `v5.9.1`, `5.9.1-rc1` and `release-5.9.1` all produce complete silence —
no run, no error, nothing to notice.

```bash
git tag -d <bad-tag>
git push origin :refs/tags/<bad-tag>
git tag X.Y.Z <commit>
git push origin X.Y.Z
```

Read the current pattern before assuming this diagnosis:
```bash
sed -n '1,10p' .github/workflows/release.yml
```

### 3. Run failed at "Validate version metadata"
The guard fails the run when the tag disagrees with `manifest.json` or
`package.json`, or when `versions.json` has no entry for the tag. The message
names which one. Root causes, in order of likelihood:

- The version bump was not committed before tagging, or the tag sits on an
  earlier commit than the bump.
- `versions.json` was hand-edited or skipped — `version-bump.mjs` writes that
  entry, so a manual bump loses it.

Fix on `main`: re-run step 5 of `cut-release.md` if the bump is wrong, commit,
push, then move the tag (step 5 below). Confirm with:

```bash
python3 .claude/skills/nexus-release/scripts/check_release_ready.py --tag X.Y.Z
```

### 4. Run failed in the build
The workflow runs `npm ci` then `npm run build` — lint, CLI build, generated
sources, `tsc --noEmit`, esbuild, connector compile. Reproduce locally with the
same command; if it passes locally but fails in CI, suspect the Node version (CI
pins an exact one — `grep -A4 'setup-node' .github/workflows/release.yml`) or a
file that exists only in your working tree and was never committed. Fix on
`main`, push, then move the tag.

### 5. Move a tag onto a corrected commit
```bash
git push origin :refs/tags/X.Y.Z   # delete remote tag
git tag -d X.Y.Z                   # delete local tag
git tag X.Y.Z                      # re-create on the corrected HEAD
git push origin X.Y.Z              # re-push: this fires the workflow again
```
If a GitHub release already exists for that tag, delete it first
(`gh release delete X.Y.Z`) so the workflow publishes a clean one rather than
layering onto a partial release.

Prefer a new patch version over moving a tag that other people may already have
pulled. Moving a published tag is a last resort, not routine cleanup.

### 6. Release published but the assets are wrong
Expected: exactly `main.js`, `manifest.json`, `styles.css`, plus a build
provenance attestation. Anything else (notably `connector.js`) means a human
attached it.

You MUST NOT fix this by uploading corrected files by hand. A hand-made or
hand-edited release is not covered by the attestation the workflow generates, and
that cannot be added retroactively. Delete the release and re-run the workflow
via step 5.

### 7. Record what happened
If the failure came from guidance in this skill being wrong or missing, run
`self-refine.md` — this protocol exists because previous releases failed in
recognisable ways.

## Guidelines
- Pattern: diagnose from the workflow file and the run log, not from memory. The
  trigger pattern and the guard are both short and readable.
- Anti-pattern: publishing a release manually "just this once" to unblock. The
  attestation is the reason the workflow exists.
- Anti-pattern: deleting and re-pushing a tag repeatedly to chase a build error.
  Get the build green locally first.

## Next
Once the workflow publishes a clean release, return to `cut-release.md` step 12
to verify it, then `self-refine.md`.
