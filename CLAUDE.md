# Nexus

Obsidian community plugin (`claudesidian-mcp`, manifest id `nexus`) that exposes the
vault to AI agents over MCP. TypeScript, esbuild, Obsidian Plugin API, MCP SDK.
`isDesktopOnly: false` — **this plugin runs on mobile.**

## Hard rules

- **Never top-level import Node built-ins or npm packages with Node deps** — mobile
  has no `fs`/`path`/`stream`/`events`. Top-level imports run before any
  `Platform.isDesktop` guard. Use `desktopRequire()` or `await import()` inside a
  function.
- **Styles in `styles.css`**, never inline. No `innerHTML` with dynamic content.
  `registerDomEvent`, never `addEventListener`.
- **`requestUrl()`, not `fetch()`.** `normalizePath()` for paths — and note it does
  **not** strip `..`, so confinement needs an explicit guard.
- **Never hardcode storage roots** (`Nexus`, `.nexus`) — resolve from settings.
- **Tool parameter schemas are documentation, not validation.** There is no ajv
  behind them; guards belong in the service/normalizer layer.

## Layout

| Path | Contents |
|---|---|
| `src/agents/` | Agents and their tools (`apps/` = opt-in app agents) |
| `src/services/` | LLM providers, memory, conversations, chat, agent registration |
| `src/database/` | Storage adapters, SQLite cache, migrations |
| `src/ui/`, `src/components/`, `src/settings/` | Chat view, modals, settings tabs |
| `src/main.ts`, `src/connector.ts` | Plugin entry point; MCP connector |
| `docs/plans/` | Design plans — the format to follow for new ones |
| `docs/changelog.md` | Release history |

## Architecture in five lines

- **Agent-Tool pattern.** Agents extend `BaseAgent` and register tools extending
  `BaseTool<Params, Result>`. Results are `{ success, ...data }` or
  `{ success: false, error }`.
- **MCP exposes exactly two tools** — `getTools` (discovery) and `useTools`
  (execution). Every other agent is internal.
- **Storage is hybrid**: sharded JSONL event store is the source of truth, SQLite is
  a rebuildable cache.
- **Services** are singletons with constructor injection.
- **The AI never gets a destructive delete** — it gets `archive`, which is
  reversible. Permanent delete is UI-only.

## Commands

```bash
npm run dev        # esbuild dev build
npm run build      # full production build (lint → CLI → tsc → esbuild → connector)
npm run test       # Jest
npm run lint       # ESLint
npm run schemas:tools   # regenerate the tool catalog — writes docs/generated/ by
                        # default; pass --output cli-first-tool-schemas.json for
                        # the repo-root file the shipped-docs test reads
```

Releases go through the `nexus-release` skill.

## Where the details live

This file stays short on purpose. Anything specific or procedural is a skill:

| Skill | Covers |
|---|---|
| `nexus-agents` | Adding a tool or agent, the two-tool MCP contract, why a command won't resolve |
| `nexus-mobile-compat` | Vetting a dependency, importing without crashing init, confining a vault path |
| `nexus-storage` | Changing the schema, persisting data, migrating and recovering it |
| `nexus-llm-adapters` | Adding a provider adapter, streaming and reasoning, local and CLI providers |
| `nexus-testing` | Picking a lane, writing a test that can fail, the in-app Obsidian CLI loop |
| `nexus-release` | Cutting a release and recovering when the workflow doesn't fire |
| `nexus-model-updates` | Registry entries, provider defaults, proving a model id works |
| `nexus-model-eval` | Grading a model, and whether a low score indicts it or the harness |
| `nexus-eval-harness` | Authoring scenarios and changing the harness itself |
| `nexus-tool-schemas` | Exporting the tool catalog and refreshing the committed one |
| `nexus-ui-mockups` | Mocking up a UI change before writing production code |

### `.skills/` is the source; the agent folders are mirrors

Edit skills in **`.skills/<name>/`**, then run `npm run sync:skills` to copy them
into `.claude/skills/`, `.codex/skills/` and `.cline/skills/`. Those three are
generated — a change made directly in one is silently reverted the next time the
sync runs. `--prune` additionally deletes any mirrored skill with no source
folder, so a skill that exists only in a mirror is not safe there.

Each skill is a slim router: `SKILL.md` names its `protocols/` (the how) and
`references/` (the why, read on demand), and most carry a `scripts/` validator
you can run directly. Prefer the validator over trusting prose — nothing in
`.claude/skills/**` is covered by the shipped-docs test, so these files have no
other guard.

## What does not belong in this file

Status. In-flight work, branch names, "uncommitted, do not commit", open PRs,
per-release narratives, session state. All of it goes stale within days and then
actively misleads — a stale "do not commit" note once described code that had
already shipped.

Current work lives in GitHub issues and `docs/plans/`. Release history lives in
`docs/changelog.md`. What the code does lives in the code.
