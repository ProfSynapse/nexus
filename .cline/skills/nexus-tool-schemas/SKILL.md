---
name: nexus-tool-schemas
description: Export the live CLI-first Nexus tool catalog as JSON — the whole registry or a selector-picked subset — and refresh the committed catalog that the repo's guidance and drift tests read. Use when someone asks for tool schemas or the exact command/argument shape a caller sees, after changing a tool's parameter schema, slug or description, after touching ToolCliNormalizer, or when a catalog-backed test fails.
---

# Nexus Tool Schemas

Context: the exporter boots the agent registry headlessly and asks the live
`ToolCliNormalizer` for each tool's CLI schema, so the JSON is the caller's-eye
view of the tools rather than a parse of the TypeScript. It runs with no
Obsidian, no vault and no build — but it does need `npm install`, and it writes
to two different files for two different jobs.

## Workflow
1. Decide which job this is. The answer is the output path, and choosing it by
   default is the standard failure here — the default path is a scratch file
   nothing reads.
   - Reading, answering a question, inspecting a subset →
     `protocols/export-subset.md`
   - Refreshing the catalog the repo ships and tests against →
     `protocols/refresh-catalog.md`
2. Run that protocol end to end. You MUST NOT hand-write or hand-patch either
   JSON file: both are generated, and an edited catalog makes the drift test the
   only thing standing between a wrong doc and a caller.
3. Validate what you produced with `scripts/check_catalog.py` before reporting
   it, and treat a non-zero exit as a stop.
4. At the end of a session that used this skill, run `protocols/self-refine.md`.

## Map
- `protocols/` the two export jobs, plus self-refine.
- `references/` `consumers.md` (which file each reader expects, and what breaks
  when it is stale) and `exporter-internals.md` (how the headless boot works,
  what it needs, and its failure modes).
- `scripts/check_catalog.py` validates an exported catalog;
  `scripts/check_exporter_coverage.py` catches an agent the exporter cannot see.
  Run them, do not reimplement.
- `refinement-log.md` what past sessions changed here and why.

## Siblings
- Adding or renaming an agent or tool, or a command that does not resolve:
  `nexus-agents`. It owns the slug-to-CLI-name transform (`cli_name.py`) and the
  checker for commands written in docs (`check_documented_commands.py`).
- Jest lanes, the shipped-docs gate and how to make a failing test fail for the
  right reason: `nexus-testing`.
- Shipping the refreshed catalog in a version: `nexus-release`.
