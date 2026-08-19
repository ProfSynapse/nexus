# Protocol: refresh-catalog

Context: `<repo>/schemas/manifest.json` points at the versioned CLI and MCP catalogs for
the current release. The two repo-root JSON files are compatibility aliases.
Any change to either live surface makes the bundle stale. This is the
consequential export; `export-subset.md` is the throwaway one.
Read `../references/consumers.md` for who reads what.

## Mission
Regenerate the current release bundle from the live registries and prove every
consumer sees the same CLI and MCP contracts.

## Steps
1. Confirm the exporter can run. It transpiles TypeScript in-process and mocks
   Obsidian, so it needs no vault, no running plugin and no build — but it does
   need dependencies installed. If `node_modules` is absent, run `npm install`
   first. If you cannot install, STOP and say the catalog could not be
   regenerated; you MUST NOT hand-write or hand-patch the JSON to compensate.
2. If an agent was added, removed or renamed since the last export, check the
   exporter's roster before generating — it constructs its agents by hand, so a
   new agent is silently missing from every export until it is added there:

   ```bash
   python3 .claude/skills/nexus-tool-schemas/scripts/check_exporter_coverage.py
   ```

   Fix `instantiateAgents()` in scripts/generate-tool-schemas.mjs before
   continuing if it reports a missing agent.
3. Generate the versioned release bundle. The script reads the version from
   `package.json`, writes both release artifacts, advances the manifest, and
   refreshes the compatibility aliases.

   ```bash
   npm run schemas:release
   ```

   The exporter prints the resolved path, tool count and per-agent counts.
4. Validate the file you just wrote:

   ```bash
   npm run schemas:check
   python3 .claude/skills/nexus-tool-schemas/scripts/check_catalog.py cli-first-tool-schemas.json
   ```

5. Run the two tests that consume it:

   ```bash
   npx jest tests/unit/ToolManagerCliSyntax.test.ts tests/unit/shippedGuidanceCommands.test.ts --no-coverage
   ```

6. Read a failure before fixing it. A drift failure in ToolManagerCliSyntax means
   the catalog and the registry disagree — usually step 3 was skipped or written
   to the wrong path. A failure in shippedGuidanceCommands means a shipped doc
   names a tool or flag that no longer exists: the catalog is right and the doc
   is stale, so fix the doc, never the catalog. That repair has its own protocol
   in the `nexus-testing` skill, `fix-shipped-docs-drift.md`.
7. Report the path written, the counts the exporter printed, and the test result.
   Do not report a refresh that ended at step 3.

## Guidelines
- Pattern: regenerate, then read the diff. A refresh that changes nothing means
  the change did not reach the caller-facing schema, which is worth knowing.
- Anti-pattern: using a selector/scratch export as a release refresh. It does
  not update the manifest or MCP surface.
- Anti-pattern: editing the JSON to make a test pass. The test exists to detect
  exactly that divergence.

## Next
Run `../scripts/check_catalog.py` on the artifact if you have not, then close the
session with `self-refine.md`. Releases are `nexus-release`'s job, not this one.
