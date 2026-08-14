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
| `nexus-agents` | Agent/tool inventory, the two-tool MCP contract, adding an agent |
| `nexus-mobile-compat` | Plugin store rules, mobile crash classes, vetting a dependency |
| `nexus-storage` | Event store, SQLite schema and migrations, path resolution, caches |
| `nexus-llm-adapters` | Streaming, reasoning rendering, local-model and CLI-provider quirks |
| `nexus-testing` | Test lanes, live smoke pattern, what a mock can and cannot prove |
| `nexus-release` | Version bump and GitHub release |
| `nexus-model-updates` | Provider model definitions and live smoke test |
| `nexus-model-eval`, `nexus-eval-harness` | Grading models on tool use |
| `nexus-tool-schemas` | Exporting live CLI tool schemas |
| `nexus-ui-mockups` | Standalone UI mockups before implementation |

## What does not belong in this file

Status. In-flight work, branch names, "uncommitted, do not commit", open PRs,
per-release narratives, session state. All of it goes stale within days and then
actively misleads — a stale "do not commit" note once described code that had
already shipped.

Current work lives in GitHub issues and `docs/plans/`. Release history lives in
`docs/changelog.md`. What the code does lives in the code.
