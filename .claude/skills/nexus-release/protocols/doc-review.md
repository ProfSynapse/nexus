# Protocol: doc-review

Context: a phase of `cut-release.md`, also worth running on its own. Nexus ships
its own guidance — the README, the `<repo>/guide/` folder, the CLI skill and its
playbooks — and for an AI caller that guidance *is* the interface. A stale flag or
a renamed tool in an example is indistinguishable from a product bug on the
receiving end.

## Mission
Bring user-facing documentation in line with what merged since the last release,
and prove it mechanically rather than by reading.

## Steps

### 1. See what landed
```bash
git describe --tags --abbrev=0                              # last release tag
git log --no-merges --format='%h %s' <last-tag>..HEAD
```

### 2. Separate user-facing from internal
Keep: new apps, new tools, new UI surfaces, changed behaviour, new or renamed
settings. Drop: refactors, type fixes, test-only commits, dependency bumps.

### 3. Update only user-facing docs
Scope is strictly `README.md` and `<repo>/guide/`. Everything under
`<repo>/docs/` is developer/internal material the maintainer manages separately —
with the single exception of `<repo>/docs/changelog.md`, which is part of the
release.

Surfaces that most often need a change:

| Surface | What lives there |
|---|---|
| `<repo>/guide/apps.md` | the **Available Apps** table — app name, its tools, desktop-only/experimental marks |
| `README.md` | the **Use Cases** and **Mobile Support (Experimental)** sections |
| `<repo>/guide/` feature pages | e.g. task management, workspace memory, semantic search, adaptive search, the CLI guide |

Confirm exact tool names, flags and enum values against `<repo>/src/` rather than
copying a previous doc forward.

### 4. Run the mechanical gate — do not rely on reading
```bash
npx jest tests/unit/shippedGuidanceCommands.test.ts
```
It parses every shipped example against the generated tool catalog
(`cli-first-tool-schemas.json` at the repo root) and asserts: every documented
command names a real agent, tool and flag; no tool flag collides with the CLI's
`-stdin`/`-file` transport suffixes; every playbook `tools:` frontmatter selector
resolves; every tool in the `<repo>/guide/apps.md` Apps table is a registered slug;
every relative doc link resolves; every embedded `--prompts` payload satisfies the
item contract.

It reads `README.md`, `<repo>/skill/SKILL.md`, `<repo>/skill/playbooks/*.md`,
`<repo>/cli/nexus-cli.ts`, `<repo>/cli/agents-snippet.md` and `<repo>/guide/*.md`.
It does **not** read anything under `<repo>/docs/` or `<repo>/.claude/skills/`, so
those two trees are still on you.

A failure prints file, line, the offending command and the reason. **Fix the doc,
not the test.**

### 5. If this release adds, renames or removes a tool
The catalog the gate above validates against is a committed snapshot. Refresh it
or every check in step 4 validates against stale truth:

- Regenerate `cli-first-tool-schemas.json` at the repo root — the `nexus-tool-schemas`
  sibling skill owns this, including the flag needed to write the repo-root file
  rather than the default generated-docs path.
- `tests/unit/ToolManagerCliSyntax.test.ts` carries a drift assertion against the
  live registry, so a stale snapshot also surfaces there.

### 6. Confirm the doc changes are actually staged
`<repo>/.gitignore` ignores `docs/*` with an allowlist of subtrees that does not
name `changelog.md`. The changelog is tracked, so edits to it are picked up — but
a *new* file added under `docs/` may be silently ignored.

```bash
git status --porcelain
git check-ignore -v docs/changelog.md   # prints a rule only if it is being ignored
```

### 7. Commit the doc updates
Commit to `main` before tagging — separately or folded into the version commit.
Docs that land after the tag are not in the release.

## Guidelines
- Pattern: when a doc change is large or you are unsure what the feature does,
  surface it to the user instead of writing a confident guess into shipped guidance.
- Anti-pattern: editing anything under `<repo>/docs/` other than the changelog to
  "keep docs in sync". That tree is not the user-facing surface.
- Anti-pattern: skipping step 4 because the diff looked small. Renamed tools are
  invisible to skimming; that is exactly what the gate exists for.

## Next
Return to `cut-release.md` step 4 (changelog), or if run standalone, commit and stop.
