---
name: nexus-agents
description: How to add, change and verify a Nexus agent or tool, and the contract every tool must satisfy. Use when adding or modifying an agent or tool, when a documented command does not resolve, when wiring registration or capability gating, or when touching the ToolManager payload shape.
---

# Working on Nexus Agents & Tools

## The shape you are working inside

MCP exposes exactly **two** tools — `getTools` (discovery) and `useTools`
(execution). Every other agent is internal and reached through them. Adding an
agent does not add an MCP tool; it adds something discoverable *through* those two.

Four invariants your change must not break:

1. **Context is enforced, not merely declared.** `useTools` validates
   `{ workspaceId, sessionId, memory, goal, constraints? }` before dispatch and
   throws a *recoverable steering error* on empty or placeholder `memory`/`goal`.
   Discovery is exempt. The eval harness imports the same validator — one source,
   don't fork it.
2. **The payload is CLI-first.** A `tool` string plus context fields at the top
   level. The nested `{context, calls}` and `{request}` shapes are gone with no
   compat shim; they throw `Deprecated payload shape`.
3. **The AI gets no delete tool.** Destructive operations are exposed as `archive`,
   which is reversible. Permanent delete is UI-only. If you are adding a tool that
   destroys something, that is a design decision to raise, not to make quietly.
4. **Results are `{ success: true, ...data }` or `{ success: false, error }`.**

## Find what exists

Never trust a written inventory, including one in a doc like this. Ask the tree:

```bash
ls src/agents/ src/agents/apps/                   # agents
grep -n "slug:" src/agents/<agent>/<agent>.ts     # that agent's tool slugs
```

For the CLI names a caller actually types, regenerate the catalog rather than
deriving them by hand:

```bash
npm run schemas:tools -- --output cli-first-tool-schemas.json
grep '"command"' cli-first-tool-schemas.json
```

Slugs are not CLI names. `toKebabCase` (`ToolCliNormalizer`) kebab-cases **and
strips a trailing `Manager`/`Agent`/`Tools`** — which is why `searchManager` is
`search`, `webTools` is `web`, and the slug `subagent` is typed `prompt sub`. When
in doubt, run the transform instead of guessing:

```bash
node -e 'const f=v=>v.replace(/Manager$/i,"").replace(/Agent$/i,"").replace(/Tools$/i,"").replace(/([a-z0-9])([A-Z])/g,"$1-$2").replace(/[_\s]+/g,"-").replace(/--+/g,"-").toLowerCase();console.log(f("yourSlug"))'
```

## Add a tool to an existing agent

1. Create `tools/<toolName>.ts` extending `BaseTool<Params, Result>`. `execute()`
   and `getParameterSchema()` are abstract; `getResultSchema()` has a default and
   is override-only.
2. Register it in the agent constructor. `registerLazyTool({slug, name,
   description, version, factory})` is the norm — use eager `registerTool(new X())`
   only when construction needs dependencies the factory cannot reach.
3. **Put your validation in `execute()` or the service, not the schema** (see
   Gotchas). Guard every field you will persist or pass to the filesystem.
4. If the tool must only exist under some condition (a credential, a platform),
   register it conditionally in the constructor rather than registering a tool that
   always fails.

**Verify:**

```bash
npm run build                                     # typecheck + bundle
npm run schemas:tools -- --output cli-first-tool-schemas.json
grep '"command"' cli-first-tool-schemas.json | grep <your-tool>
```

The command string in that catalog is what a caller must type. If it is not what
you expected, the kebab transform changed it. Then exercise it for real — through
`getTools` to confirm discovery, and `useTools` to confirm execution, since
registration and executability are separate failures.

## Add a new agent

Two touchpoints. No factory classes, no ServiceDefinitions entry.

1. `initializeYourAgent()` in `src/services/agent/AgentInitializationService.ts`
2. `safeInitialize('yourAgent', ...)` in a phase of
   `AgentRegistrationService.doInitializeAllAgents()`

Phase 1 is for agents with no dependencies, phase 2 for dependent ones, phase 3 for
app agents, and phase 4 is ToolManager — which **must stay last**, because it
snapshots the registry of everything else.

To make an agent conditional, `return` early from the initializer when a hard
dependency is missing. `safeInitialize` catches and logs any throw, so a failed
agent is absent rather than half-registered — absent is the correct outcome, since
a tool that can only answer "unavailable" wastes a discovery round-trip.

**Verify:** build, then confirm the agent appears in `getTools` discovery and that
one of its tools executes through `useTools`.

## Gotchas

Each of these has bitten. They are listed by the symptom you will actually see.

**"My documented command returns nothing / unknown tool."** The CLI name is not the
slug — `toKebabCase` strips a trailing `Manager`/`Agent`/`Tools`. A tool whose slug
ends in `Agent` advertises without it. Check the generated catalog, not the source.

**"Malformed params reached my service and persisted garbage."** `getParameterSchema()`
is documentation plus CLI-normalizer hints. There is no ajv behind
`ToolBatchExecutionService.execute()` — `required`, `oneOf` and `enum` do **not**
reject anything at runtime. The one place `required` has teeth is a command typed
as a `tool` string, where the normalizer raises `Missing required argument`; it
still does not check value shape or `enum` membership. Guards belong in the
service/normalizer layer. Origin: a `linkedNotes` object missing `notePath`
silently persisted `notePath: undefined` until `normalizeLinkedNote` guarded it.

**"My comma-separated argument got split into two commands."** A top-level comma
outside quotes separates batched commands — but only when followed by whitespace or
end of input. `--paths a,b,c` stays one CSV value; `--paths a, b` does not.

**"Deprecated payload shape."** Something is still sending `calls`, `request`, or a
nested `context` object. Context fields go at the top level, and must not appear as
CLI flags inside the tool string either.

**"My multiline content arrived flattened or mangled."** Use the verbatim
transports rather than inlining: the top-level `values` map referenced as `@key`
(substituted after tokenization, no escape processing, so backslashes and newlines
survive), or `--<flag>-stdin` / `--<flag>-file <path>` on the terminal CLI. One
`-stdin` per command, and a flag must not arrive both directly and via a transport.

**"I passed a capability flag and the agent registered anyway."** The existing
`enableSearchModes` / `enableLLMModes` flags are **not** a gating pattern to copy.
The search flag lands on an ignored legacy parameter and all its tools register
regardless; PromptManager registers either way behind a fallback provider manager.
Gate by returning early, or by conditional per-tool registration.

**"My tool is discoverable but returns 'Execution context not available'."**
Discovery and executability are separate. Some tools need a runtime collaborator
wired by the chat UI; registration alone does not make them callable.

**"I edited `cliAssets.ts` and my change vanished."** It is generated by
`scripts/generate-cli-content.mjs` during the build from `skill/SKILL.md`,
`cli/agents-snippet.md` and `skill/playbooks/*.md`. Edit the sources.

**"`npm run schemas:tools` did not fix the shipped-docs test failure."** It writes
`docs/generated/cli-first-tool-schemas.json` by default, while
`tests/unit/shippedGuidanceCommands.test.ts` validates against the **repo-root**
catalog. Pass `--output cli-first-tool-schemas.json` to refresh the one the gate
reads.

**"A doc named a tool that does not exist and nothing caught it."** That gate reads
README, `skill/SKILL.md`, `cli/nexus-cli.ts`, `cli/agents-snippet.md`,
`skill/playbooks/*.md` and `guide/*.md` — it does **not** read `.claude/skills/**`.
Anything you write in a skill file is unguarded, which is why this file names
commands to run rather than listing tools.

**"My new dynamic registrar broke `getTools` discovery."** The
`syncToolManagerAgent` bridge keeps discovery in sync when `AppManager` installs
app agents at runtime, and works only because `AppManager` is the *only* dynamic
registrar. It does not compose for a second one. When one lands, refactor to
events (`onAgentRegistered`/`onAgentUnregistered` on `AgentManager`, subscribed in
`ToolManagerAgent`) rather than adding a second bridge — see
https://github.com/ProfSynapse/nexus/issues/174. Do not do it speculatively.

## Where the details live

- Agent and tool base classes: `src/agents/baseAgent.ts`, `src/agents/baseTool.ts`,
  interfaces in `src/agents/interfaces/`
- App agents: `src/agents/apps/BaseAppAgent.ts`, plus `AppRuntimeContext` for
  settings, storage-adapter and session-context access. App agents that write files
  use `vault.createBinary()` for binary output and `vault.create()` for text, and
  must ensure parent directories exist first.
- Payload normalization and the kebab transform: `ToolCliNormalizer`
- MCP surface: `src/handlers/strategies/ToolListStrategy.ts` returns the two tools;
  the server key comes from `getPrimaryServerKey()` in `src/constants/branding.ts`
- Traces: `src/services/trace/ToolCallTraceService.ts`
