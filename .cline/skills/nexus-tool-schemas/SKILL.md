---
name: nexus-tool-schemas
description: Export live CLI-first Nexus tool schemas as JSON. Use when the user wants every tool schema, a subset by selector, or an artifact that reflects the current runtime command/argument shape instead of source parsing.
---

# Nexus Tool Schemas

Use this skill when the task is to generate or refresh JSON exports of the plugin's CLI-first tool schemas.

## What It Uses

- `scripts/generate-tool-schemas.mjs`
- The live `ToolCliNormalizer.buildCliSchema()` runtime path

This is the source of truth for the exported shape. Do not hand-assemble schema JSON unless the script is broken and you are fixing it.

## Default Command

Run:

```bash
npm run schemas:tools
```

This writes the default full export to:

```text
docs/generated/cli-first-tool-schemas.json
```

## Arbitrary Subsets

Use `--selector` with the same selector grammar as `getTools`:

```bash
npm run schemas:tools -- --selector "storage"
npm run schemas:tools -- --selector "storage move, content read"
npm run schemas:tools -- --selector "prompt generate-image"
```

Use `--output` to control the destination:

```bash
npm run schemas:tools -- --selector "task" --output docs/generated/task-tool-schemas.json
npm run schemas:tools -- --selector "web-tools capture-to-markdown" --output -
```

`--output -` prints JSON to stdout instead of writing a file.

## Workflow

1. Decide whether the user wants all tools or a selector-based subset.
2. Run the exporter script with `--selector` and `--output` as needed.
3. Return the output file path and a short summary of tool/agent counts.
4. If the skill itself was updated, sync skills with:

```bash
npm run sync:skills
```

## Guardrails

- Prefer the exporter over reading TypeScript source by hand.
- Treat selector strings as the public interface. If the user names an agent/tool informally, convert it to the CLI alias form used by `getTools`.
- If the export is being committed, regenerate the affected JSON artifact after changing any tool schema or CLI-normalizer behavior.
