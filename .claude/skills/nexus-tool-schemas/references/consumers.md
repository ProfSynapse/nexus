# Who reads the catalog

Two files with the same basename exist, and only one of them is read by
anything. Getting this wrong is the mistake this skill exists to prevent,
because every symptom of it looks like success.

## The repo-root catalog

Path: cli-first-tool-schemas.json at the repository root. Not gitignored, so it
is versioned with the code, and it is what the exporter writes only when you
pass `--output cli-first-tool-schemas.json`.

Two Jest tests read it, both by resolving the repo root and reading that exact
basename:

- tests/unit/ToolManagerCliSyntax.test.ts boots a real registry and compares it
  against the snapshot, in both directions: a live tool absent from the catalog
  fails, and a catalog flag that no longer exists live fails. This is the test
  that tells you the refresh was skipped.
- tests/unit/shippedGuidanceCommands.test.ts validates the commands written in
  the shipped guidance — README, the packaged skill and its playbooks, the guide
  directory, the CLI entry point — against the catalog: unknown agent, unknown
  tool, unknown flag, and missing required arguments on complete examples. It
  also asserts no tool flag collides with the CLI's `-stdin`/`-file` transport
  suffixes.

When the only question is "did I write to the path the gate reads", the
`nexus-testing` skill ships `check_catalog_target.py` for exactly that; this
skill's `../scripts/check_catalog.py` answers it as a byproduct of validating
the artifact's contents.

The second test is the reason a stale catalog is worse than an absent one. It
does not fail when the catalog is old; it keeps passing, validating shipped
guidance against tools as they used to be. The drift test in the first file
exists specifically to stop that from going quiet.

## The default destination

Path: docs/generated/cli-first-tool-schemas.json, where `npm run schemas:tools`
writes when given no `--output`. The repo's ignore rules cover docs with a
narrow allowlist that does not include a generated directory, so this file is
never committed, and no test, script or shipped doc reads it. It is a fine place
for a scratch export and the wrong place for a refresh.

## Skills and other markdown

The shipped-docs gate does not read the skills directory, so a command written
in a skill file is unguarded by it. The `nexus-agents` skill ships
`check_documented_commands.py` for that gap — point it at any markdown file or
directory and it resolves every command found against the catalog. It looks for
the repo-root catalog first and falls back to the default destination, so it
reports which one it used.
