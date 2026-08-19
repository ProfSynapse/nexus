# How the exporter runs, and how it fails

The exporter is scripts/generate-tool-schemas.mjs. `schemas:release` writes the
versioned CLI/MCP bundle; a direct call remains available for scratch subsets.
Everything below is a consequence of how it boots.

## The headless boot

It installs a `.ts` require hook that transpiles TypeScript with the `typescript`
package, redirects `require('obsidian')` to the repo's Obsidian test mock,
fabricates an App and Plugin with stubbed vault and workspace methods,
constructs each agent directly, puts them in a Map registry and calls
`ToolCliNormalizer.buildCliSchema` for every selected tool.

What follows from that:

- **No Obsidian, no vault, no build.** It does not attach to a running plugin and
  does not read a real vault. There is nothing to open and no CLI to drive.
- **Dependencies are required.** Without an installed `node_modules` the
  transpiler and the agents' own imports are missing and the run dies on the
  first require. `npm install` is the only fix; there is no offline fallback.
- **Provider keys are faked.** It injects placeholder API keys and enables a few
  providers so that provider-gated tools construct. It never calls a provider.

## The hardcoded roster

`instantiateAgents()` lists the agent classes by hand and passes each
constructor its arguments explicitly. Two failure modes come from that, and
`../scripts/check_exporter_coverage.py` exists for the first:

- An agent registered by the plugin but absent from that list is silently absent
  from every export. Nothing throws; the catalog is simply short, and the drift
  test is what eventually notices.
- A change to an agent's constructor signature breaks the exporter even though
  the plugin builds fine, because the arguments here are written out rather than
  resolved from the real initialization service.

App agents are opt-in per vault at runtime, but the exporter constructs them
unconditionally, so the catalog always contains them.

## What the schema contains

- **Full schemas, always.** `buildCliSchema` has a compact mode that live broad
  discovery uses, so a real `getTools("--help")` call returns command and
  description only. The exporter never asks for compact, so the exported catalog
  carries usage, arguments and examples for every tool at any scope. The export
  is a superset of what a caller sees from a broad call.
- **No context parameters.** `stripCommonParams` removes the top-level context
  keys (workspaceId, sessionId, memory, goal, constraints and friends) before
  building arguments, which is why they never appear as tool flags.
- **CLI names, not slugs.** `command` is the agent alias plus the kebab-cased
  tool slug, where a trailing Manager, Agent or Tools is stripped first — this is
  what turns the `subagent` slug into `prompt sub` and `webTools` into `web`. The
  `agent` field beside it keeps the internal registry name, which is why the two
  disagree. Agent names are declared on each class, not derived, so never compute
  one from a class name.
- **Sorted and counted.** Tools are sorted by command, and the header carries
  generatedAt, the selector used, tool and agent counts, and a per-agent tally.

## Failure messages you will actually see

- `Unknown agent "..."` or `Unknown tool "..." for agent "..."` — the selector
  used a registry name or a slug where the CLI alias belongs.
- `Invalid selector "..."` — more than two tokens in one segment. Selector
  segments are `agent` or `agent tool`, nothing deeper.
- `Unknown argument: ...` — run `node scripts/generate-tool-schemas.mjs --help`
  for the current accepted release, check, selector and output flags.
