# Protocol: fix a shipped-docs drift failure

Context: guidance IS the interface for an AI caller. A stale flag or a renamed
tool in a shipped example is indistinguishable from a product bug on the
receiving end, so two unit tests pin the docs to the generated tool catalog at
the repo root, `cli-first-tool-schemas.json`:

- `tests/unit/shippedGuidanceCommands.test.ts` validates every tool command the
  repo ships as guidance against that catalog. It fails on an unknown
  agent/tool/flag, a playbook selector that resolves to nothing, a missing
  required argument in a **complete, copy-pasteable** example, a broken relative
  doc link, and an embedded `--prompts` payload that violates the item contract.
- `tests/unit/ToolManagerCliSyntax.test.ts` pins the catalog against the *live*
  registry, so the guidance check cannot go quietly vacuous when the snapshot
  drifts.

Two failures with one cause is the expected signature, not two bugs.

## Steps

1. **Read the failure text and decide which of two things is wrong.** The whole
   protocol turns on this, and guessing wastes the pass.

   | The failure says | Cause | Go to |
   |---|---|---|
   | a doc names an agent/tool/flag that does not exist, or an example is missing a required argument | the docs are wrong | step 2 |
   | a live tool is absent from the catalog, or a catalog flag no longer exists live | the catalog is stale | step 4 |

2. **Docs wrong: edit the source guidance.** Get the current source list from
   the test itself rather than any written list, including this one:

   ```bash
   sed -n '/function guidanceFiles/,/^}/p' tests/unit/shippedGuidanceCommands.test.ts
   ```

3. **You MUST NOT hand-edit `src/utils/cliAssets.ts`.** It is GENERATED — the
   build runs `scripts/generate-cli-content.mjs`, which embeds the built CLI
   bundle and the guidance sources and overwrites that file. An edit there
   disappears at the next build and takes your fix with it. Fix the source, then
   rebuild.

4. **Catalog stale: regenerate it to the path the gate actually reads.** The
   generator defaults to writing under `docs/generated/`, which is **not** the
   repo-root file these tests load. Pass the output path explicitly:

   ```bash
   node scripts/generate-tool-schemas.mjs --output cli-first-tool-schemas.json
   # or: npm run schemas:tools -- --output cli-first-tool-schemas.json
   ```

   Regeneration needs a running vault. The procedure for that belongs to the
   `nexus-tool-schemas` skill — follow it there.

5. **Verify you wrote to the right place**, then re-run both tests:

   ```bash
   python3 .claude/skills/nexus-testing/scripts/check_catalog_target.py
   npx jest tests/unit/shippedGuidanceCommands.test.ts tests/unit/ToolManagerCliSyntax.test.ts --no-coverage
   ```

6. **If the gate still fails after a regeneration that looked fine**, you almost
   certainly regenerated to the default path. Step 5's check exists for exactly
   that; read what it printed.

## Guidelines

- Pattern: when a doc and the catalog disagree, ask which one a caller would be
  hurt by. Usually the doc taught a shape that then broke — that is the defect,
  and the catalog is the evidence.
- Anti-pattern: relaxing an assertion in the guidance test to get green. The
  test is the only thing in the suite that reads those files.
- Anti-pattern: regenerating the catalog to make a *doc* error disappear. It
  will not, and now the snapshot moved for no reason.

## Next

Once both tests are green, this protocol is complete. If the fix changed a tool
surface rather than a doc, verify the change in the app at `live-loop.md`. End
the session at `self-refine.md`.
