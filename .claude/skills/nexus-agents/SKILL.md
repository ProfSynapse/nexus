---
name: nexus-agents
description: How to add, change and verify a Nexus agent or tool, and the contract every tool must satisfy. Use when adding or modifying an agent or tool, when a documented command does not resolve, when wiring registration or capability gating, or when touching the ToolManager payload shape.
---

# Nexus agents and tools

Context: Nexus exposes exactly two MCP tools — `getTools` (discovery) and
`useTools` (execution). Every agent is internal and reached through those two, so
adding an agent adds no MCP tool; it adds something discoverable *through* them.
This file routes. The detail loads when you take the path.

## Workflow
1. Get current truth before you write anything. Trust no inventory in any
   document, including this one — regenerate the catalog and read it. It lists
   every command a caller can actually type, and it is the artifact the
   shipped-docs gate reads:
   ```bash
   npm run schemas:tools -- --output cli-first-tool-schemas.json   # refresh in place
   npm run schemas:tools -- --output - --selector "storage"        # inspect, write nothing
   ls src/agents/ src/agents/apps/                                 # who exists
   grep -n "slug:" src/agents/<agent>/<agent>.ts                   # that agent's slugs
   ```
2. Take the protocol for the job. Read it before acting; a summarized procedure
   is one you will improvise.
   - Adding a tool to an existing agent: `protocols/add-tool.md`
   - Adding an agent (core or app): `protocols/add-agent.md`
   - Changing the `useTools`/`getTools` payload or the CLI grammar:
     `protocols/change-payload-contract.md`
   - Something already broke: start at `references/failure-modes.md`, which is
     keyed by the symptom you are seeing.
3. You MUST finish at `protocols/verify.md`, whichever path you took. Discovery
   and executability fail separately: a tool can register and still not run, and
   a command that reads correctly in source can advertise under a different name.
   Neither is visible from a build that passes.
4. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map
- `protocols/` the procedures: add-tool, add-agent, change-payload-contract,
  verify, self-refine.
- `references/` read on demand: `contract.md` (the invariants a change must not
  break), `cli-names.md` (what a slug becomes on the command line, and the
  parsing rules that follow), `registration.md` (where an agent gets wired and
  what actually gates one), `failure-modes.md` (symptom → cause → proof).
- `scripts/` run them, do not reimplement:
  - `scripts/cli_name.py` — what a slug advertises as, derived from the live
    transform in source rather than guessed.
  - `scripts/check_documented_commands.py` — every Nexus command written in a
    doc, checked against the generated catalog. The repo's own shipped-docs
    test does not read `.claude/skills/**`, so this is the only thing standing
    between this skill and a command that no longer resolves.

## Siblings
Name them, do not re-derive them. Test lanes, the live in-app loop and the eval
harness belong to `nexus-testing`; exporting schemas as a deliverable to
`nexus-tool-schemas`; provider adapters to `nexus-llm-adapters`; anything that
must survive a restart to `nexus-storage`; mobile-safe imports and vault-path
confinement to `nexus-mobile-compat`.
