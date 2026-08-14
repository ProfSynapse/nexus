---
name: nexus-agents
description: Nexus agent and tool architecture — the agent/tool inventory, the two-tool MCP contract (getTools/useTools), how to add a new agent, and the base classes. Use when adding or changing an agent or tool, when working out which tool does what, when a tool name or CLI form needs verifying, or when touching the ToolManager MCP payload shape.
---

# Nexus Agents & Tools

The plugin exposes exactly **two** MCP tools. Everything else is an internal agent
reached through them.

## Two-tool architecture

| Tool | Role |
|---|---|
| `getTools` | Discovery — returns tool schemas for requested agents/tools |
| `useTools` | Execution — unified context-first tool execution |

**Context schema:** `{ workspaceId, sessionId, memory, goal, constraints? }` — all
required except `constraints`, and **enforced at runtime**, not just declared.
`ToolCliNormalizer.collectContextContractViolations()` / `validateExecutionContext()`
run first in `useTools.ts:37` and throw a *recoverable steering error* when
`memory`/`goal` are empty or placeholder. `workspaceId`/`sessionId` keep silent
defaults and steer only on present-junk. Discovery is exempt. The eval harness
imports the same validator — single source, don't fork it.

**Payload shape — CLI-first only.** A `tool` string plus context fields at the top
level. Optional top-level `strategy: 'serial' | 'parallel'` and `values` map.

```
"storage list --path Notes, content read --path a.md --start-line 1"
```

Batch by separating commands with a top-level comma outside quotes. The comma is a
separator only when followed by whitespace or end of input — a comma glued to the
next character (`--paths a,b,c`) stays a CSV value inside the current command.
Context fields must NOT appear as CLI flags inside the tool string.

⚠️ The legacy nested `{context: {...}, calls: [...]}` and `{request: [...]}` shapes
were removed in v5.9.0 and throw `Deprecated payload shape` at
`src/agents/toolManager/services/ToolCliNormalizer.ts:757/775/808`. `UseToolParams`
has no `calls`/`request` fields. There is no compat shim.

**Verbatim / multiline transports** (never flatten multiline content):
- MCP/chat: top-level `values` map, referenced as `@key` in the tool string.
  Substituted *after* tokenization with no escape processing, so backslashes,
  quotes and newlines survive exactly (`C:\temp`, `\alpha`, `\d`). A missing key,
  or a declared key the command never references, fails loud.
- Terminal CLI: `--<flag>-stdin` and `--<flag>-file <path>` hydrate *any*
  value-taking flag. One `-stdin` per command; several `-file` may coexist; a flag
  must not arrive both directly and via a transport.

**`content replace`** (and `executePrompts.replace`) is pattern-anchored:
`{path, start, end, content}` where `start`/`end` are TEXT anchors matched as whole
lines (Unicode-normalized, so straight vs curly quotes compare equal) — never line
numbers.

## Tool inventory

Names below are the **CLI form** (`agent tool-name`, kebab-case). The source of
truth is the `slug:` field under `src/agents/**` — camelCase in most agents
(`webTools` declares kebab slugs directly). The CLI name is `toKebabCase(slug)`
(`ToolCliNormalizer.ts`), and the agent alias is `toKebabCase(agentName)`; that
helper **also strips a trailing `Manager`/`Agent`/`Tools`**, which is why
`searchManager` → `search`, `webTools` → `web`, and the slug `subagent` →
`prompt sub`.

Regenerate the machine-readable export with `npm run schemas:tools` — note it
writes `docs/generated/cli-first-tool-schemas.json` by default; pass
`--output cli-first-tool-schemas.json` to refresh the repo-root catalog.
`tests/unit/shippedGuidanceCommands.test.ts` validates that catalog against
README, `skill/SKILL.md`, `cli/nexus-cli.ts`, `cli/agents-snippet.md`,
`skill/playbooks/*.md` and `guide/*.md` — it does **not** read `.claude/skills/**`,
so nothing catches drift in this table. Verify against source before trusting it.

**Always-on agents (8):**

| Agent | CLI | Tools |
|---|---|---|
| PromptManager | `prompt` | execute, sub, create, get, list, update, archive, list-models, generate-image\*, generate-audio\*, generate-video\*, check-generated-artifact\* |
| ContentManager | `content` | read, write, replace, insert, set-property |
| StorageManager | `storage` | list, create-folder, move, copy, archive, open |
| SearchManager | `search` | content, directory, memory, query-notes |
| MemoryManager | `memory` | create-workspace, list-workspaces, search-workspaces, load-workspace, update-workspace, archive-workspace, create-state, list-states, load-state, update-state, archive-state, run |
| CanvasManager | `canvas` | read, write, update, list |
| TaskManager | `task` | create-project, list-projects, update-project, archive-project, create, list, update, move, query, open, link-note |
| IngestManager | `ingest` | run, capabilities |

**Opt-in app agents (5)** — a vault only exposes the apps it enables:

| Agent | CLI | Tools |
|---|---|---|
| WebToolsAgent (desktop) | `web` | open, capture-markdown, capture-png, capture-pdf, links |
| ComposerAgent | `composer` | compose, list-formats |
| ElevenLabsAgent | `elevenlabs` | list-voices, sound-effects, generate-music |
| DataAnalysisAgent (desktop) | `data` | run-python, list-capabilities |
| SkillsAgent | `skills` | list-skills, load-skill, create-skill, update-skill, archive-skill, sync-skills |

\* The four PromptManager media tools are **credential-gated**, not always-on:
`generate-image` needs a Google or OpenRouter key; `generate-audio` needs OpenAI,
Google, Mistral, OpenRouter or the ElevenLabs app; `generate-video` and
`check-generated-artifact` are registered together behind the video check. They
are registered/unregistered live from `handleSettingsChange`, so a vault without
keys simply does not expose them.

Non-obvious contracts:
- `content read` requires `--start-line` (declared `required` in `read.ts` and
  enforced for CLI commands by the normalizer's missing-required-argument check).
- `prompt sub` is the CLI form of the `subagent` slug. It is discoverable through
  `getTools`, but only executes when the chat UI has wired a `SubagentExecutor` —
  otherwise it returns "Execution context not available".
- No **delete tool** anywhere the AI can reach — the model gets `archive`
  (reversible). Permanent delete of states/workspaces is UI-only; there is no
  `deleteState` MCP tool. Destruction is still reachable indirectly: `storage
  move`/`copy` and `composer compose` trash an existing target when overwriting,
  and `content replace` deletes the anchored range.
- Media generation is mostly synchronous. `generate-image`/`generate-audio` write
  the file and return. `generate-video` runs inline and returns a `jobId` **only**
  when it exceeds its timeout (default 600000 ms); that is what
  `check-generated-artifact --job-id <id>` is for.
- No session tools — sessions are context fields. `memory run` triggers a workflow
  (`--workflow-id` or `--workflow-name`; one of the two is required).
- TaskManager naming is asymmetric: project tools are suffixed (`create-project`),
  task tools are bare (`create`, `list`).
- ElevenLabs has no registered text-to-speech tool (`TextToSpeechTool` exists in
  the tree but is never registered); TTS runs through `prompt generate-audio`.

## MCP server configuration

- The server runs locally via `connector.js` (generated into the plugin folder; the
  source is `connector.ts` at the repo root)
- Configured in Claude Desktop's `claude_desktop_config.json`
- Server identifier: **`nexus-[sanitized-vault-name]`** — `getPrimaryServerKey()` in
  `src/constants/branding.ts`, used by `ConfigModal` and `GetStartedTab` when writing
  the config. `claudesidian-mcp-[vault-name]` is the **legacy** key: still accepted
  when discovering an existing entry, never written for a new one.
- Per-vault IPC socket/pipe: `nexus_mcp_<vault>` — multiple vault instances are
  supported simultaneously
- `tools/list` returns exactly two MCP tools, `toolManager_getTools` and
  `toolManager_useTools` (`src/handlers/strategies/ToolListStrategy.ts`)
- Shipped agent-facing guidance is authored in `skill/SKILL.md`,
  `cli/agents-snippet.md` and `skill/playbooks/*.md`, then embedded into
  `src/utils/cliAssets.ts` by `scripts/generate-cli-content.mjs` — that file is
  auto-generated, never hand-edit it. Traces:
  `src/services/trace/ToolCallTraceService.ts`

## Adding a new agent

Two touchpoints. No factory classes, no ServiceDefinitions entry.

1. Add `initializeYourAgent()` to `src/services/agent/AgentInitializationService.ts`
2. Add `safeInitialize('yourAgent', ...)` to a phase in
   `AgentRegistrationService.doInitializeAllAgents()`

There are four phases: phase 1 for agents with no dependencies (content, storage,
canvas), phase 2 for dependent ones (prompt, search, memory, task, ingest), phase 3
for app agents, phase 4 for ToolManager — which **must** stay last, since it
snapshots the registry of everything else.

⚠️ Do not copy the existing capability flags as a gating pattern — they do not gate.
`initializeSearchManager(enableSearchModes, …)` passes the flag into
`SearchManagerAgent`, where it is the ignored legacy parameter `_enableVectorModes`;
all four search tools register regardless. `initializePromptManager(enableLLMModes)`
registers PromptManager either way, falling back to a minimal `LLMProviderManager`
when LLM modes are off. Real gating happens two other ways: an initializer
`return`s early when a hard dependency is missing (no prompt storage, no settings),
and individual tools are registered conditionally inside the agent constructor
(PromptManager's credential-gated media tools). `safeInitialize` catches and logs
any throw, so a failed agent is absent rather than half-registered.

## Structure and base classes

```
agents/[agentName]/
  [agentName].ts     # extends BaseAgent, registers tools in the constructor —
                     # `registerLazyTool({slug, name, description, version, factory})`
                     # is the norm; `registerTool(new XTool(...))` for eager ones
                     # with complex dependencies
  tools/[toolName].ts
  tools/services/    # tool-specific services
  services/          # agent-level shared services
  types.ts
  utils/
```

- `BaseAgent` — `src/agents/baseAgent.ts`
- `BaseTool<Params, Result>` — `src/agents/baseTool.ts`; `execute()` and
  `getParameterSchema()` are abstract, `getResultSchema()` has a default (the
  common result schema) and is override-only
- `IAgent` / `ITool` — `src/agents/interfaces/`
- App agents also extend `BaseAppAgent` (`src/agents/apps/BaseAppAgent.ts`) and may
  opt into `AppRuntimeContext` for settings, storage-adapter and session-context
  access
- Results: `{ success: true, ...data }` or `{ success: false, error: string }`

**App agents that produce files** must have vault access wired through
`BaseAppAgent`. Use `vault.createBinary()` for binary output (audio, images) and
`vault.create()` for text, and always ensure parent directories exist before
writing.

## Schema validation is documentation only

`getParameterSchema()` is DOCUMENTATION plus CLI-normalizer hints. There is **no**
ajv/JSON-schema validation behind `ToolBatchExecutionService.execute(params)`. A
schema `required`, `oneOf` or `enum` does **not** reject a malformed payload at
runtime — bad input flows straight to the service.

**Validation guards MUST live in the service/normalizer layer, not the schema.**
Origin: a `createTask.linkedNotes` oneOf object missing `notePath` silently
persisted `notePath: undefined` until an explicit guard was added in
`normalizeLinkedNote` (`src/agents/taskManager/services/TaskService.ts:78`).

## Dynamic registration limit (issue #174)

`AgentRegistrationService.syncToolManagerAgent` (`:85`) plus
`ToolManagerAgent.registerDynamicAgent/unregisterDynamicAgent`
(`src/agents/toolManager/toolManager.ts:117`) is a callback-wrap bridge keeping
`getTools` discovery in sync when `AppManager` installs/uninstalls app agents at
runtime. It works only because `AppManager` is the **only** dynamic registrar and
**does not compose** for a second one.

When a second dynamic registrar lands, refactor to events: add
`onAgentRegistered`/`onAgentUnregistered` to `AgentManager`, subscribe in
`ToolManagerAgent`'s constructor, delete the bridge and the
`instanceof ToolManagerAgent` concrete import. Do **not** do this speculatively —
wait for the triggering consumer. https://github.com/ProfSynapse/nexus/issues/174
