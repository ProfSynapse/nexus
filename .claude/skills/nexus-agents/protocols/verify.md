# Protocol: verify an agent or tool change

Context: the shared closing step for every path in this skill. Registration,
discovery and execution fail independently, and a passing build sees none of
them.

## Mission
Prove the change is discoverable under the name a caller types, executable, and
not silently rotting any document that names it.

## Steps
1. Typecheck. The fast loop is `npx tsc --noEmit --skipLibCheck`; the full
   `npm run build` also lints, rebuilds the CLI bundle and regenerates the
   generated CLI assets.
2. Refresh the catalog and read your command out of it. This is the authority on
   what a caller types — if the string is not what you expected, the kebab
   transform changed it:
   ```bash
   npm run schemas:tools -- --output cli-first-tool-schemas.json
   grep '"command"' cli-first-tool-schemas.json | grep <your-tool>
   ```
3. Run the unit lanes that encode this surface, plus any test for the agent you
   touched:
   ```bash
   npx jest tests/unit/ToolManagerCliSyntax.test.ts tests/unit/ToolManagerContextContract.test.ts \
            tests/unit/ToolManagerDynamicRegistry.test.ts tests/unit/shippedGuidanceCommands.test.ts
   ```
   For choosing or writing a test that can actually fail, use the
   `nexus-testing` skill rather than improvising a lane here.
4. Exercise it in the running plugin. Discovery and execution are separate
   failures, so you MUST do both — `getTools` for the first, `useTools` for the
   second. With Obsidian open and Nexus running, the bundled smoke script drives
   the whole path (socket → MCP handshake → discovery → a read-only execution):
   ```bash
   cli/smoke.sh [vaultName]
   ```
   A test vault is available; supply its name at run time. The CLI targets the
   single open vault, or `$NEXUS_VAULT`, and otherwise lists the open vaults and
   asks for `--vault <name>`. To drive your own tool rather than the smoke
   script's fixed commands:
   ```bash
   nexus tools <agent>                     # discovery, one agent
   nexus tools "<agent> <tool>"            # full argument schema for one tool
   nexus use --vault <name> --memory "<what has happened>" --goal "<this call>" \
             -- <agent> <tool> --flag value
   nexus use --dry-run --memory "…" --goal "…" -- <agent> <tool>   # reconstruct, do not connect
   ```
   This step needs a machine with Obsidian installed and `npm install` already
   run. If you are somewhere that has neither, say the step was not run — do not
   report it as passed.
5. Check every command this skill documents still resolves. The repo's
   shipped-docs gate does not read `.claude/skills/**`:
   ```bash
   python3 .claude/skills/nexus-agents/scripts/check_documented_commands.py .claude/skills/nexus-agents
   ```
   Point it at any other draft doc the same way. A non-zero exit is a stop: fix
   the command or the catalog, then re-run.
6. Stop condition: steps 1-3 and 5 exit clean, step 4 has been run or explicitly
   reported as not run, and the command string you documented matches the
   catalog.

## Guidelines
- Pattern: read the generated catalog rather than the source you just wrote. It
  is the only place the caller's view exists.
- Pattern: when a live run is impossible, say so plainly. An unrun step reported
  as green is worse than an admitted gap.
- Anti-pattern: concluding from a green build. It proves the code compiles and
  nothing about whether the tool is reachable.
- Anti-pattern: fixing a failing shipped-docs test by editing a generated file.
  Regenerate, or edit the source the generator reads.

## Next
`self-refine.md`, at the end of the session. That is the terminal step for this
skill.
