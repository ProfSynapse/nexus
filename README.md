![Nexus Obsidian Banner](https://picoshare-production-7223.up.railway.app/-vXLL7jFB53/nexus%20obsidian.png)

[![Release](https://img.shields.io/github/v/release/ProfSynapse/claudesidian-mcp?label=release)](https://github.com/ProfSynapse/claudesidian-mcp/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-6f42c1)](https://obsidian.md/plugins)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)](package.json)

# Nexus MCP for Obsidian

Nexus gives AI agents and built-in chat access to your Obsidian vault so you can read, write, search, organize, and automate notes in natural language while keeping storage local to the vault.

Nexus can be used in two ways:
- Inside Obsidian with native chat (hook up to your favorite provider or agentic platform!)
- From external agents like Claude Desktop, Claude Code, Codex CLI, Gemini CLI, Cursor, Cline, and other MCP clients

> Nexus is the successor to Claudesidian. Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work.

## Setup

- Install the latest release from [GitHub Releases](https://github.com/ProfSynapse/claudesidian-mcp/releases): `manifest.json`, `styles.css`, `main.js`, and `connector.js`
- Put them in `.obsidian/plugins/nexus/` and enable **Nexus** in Obsidian
- Native chat in Obsidian: [Provider setup](guide/provider-setup.md) and [Native chat guide](guide/native-chat.md)
- External agent over MCP: [MCP setup guide](guide/mcp-setup.md) and [Recommended system prompt](guide/recommended-system-prompt.md)
- Optional desktop features: [Semantic search](guide/semantic-search.md) and [Apps and integrations](guide/apps.md)

Native chat works on desktop and mobile. MCP clients, local desktop providers, and semantic search are desktop-only.

## Use Cases

| If you want to... | Start here |
|---|---|
| Connect Claude Desktop, Codex CLI, Gemini CLI, Cursor, Cline, or another MCP client | [MCP setup](guide/mcp-setup.md) |
| Configure built-in chat providers inside Obsidian | [Provider setup](guide/provider-setup.md) |
| Give your agent better instructions for using Nexus | [Recommended system prompt](guide/recommended-system-prompt.md) |
| Manage long-running work with persistent workspace context | [Workspace memory](guide/workspace-memory.md) |
| Track projects, tasks, blockers, and dependencies | [Task management](guide/task-management.md) |
| Search notes and past conversations by meaning | [Semantic search](guide/semantic-search.md) |
| Edit selected text directly in notes | [Inline editing](guide/inline-editing.md) |
| Open webpages in Obsidian and save them as Markdown, PNG, or PDF *(experimental)* | [Apps](guide/apps.md) |
| Convert PDFs and audio files to Markdown notes — right-click in vault or auto on add *(experimental)* | [Apps](guide/apps.md) |
| Merge PDFs, concat markdown, or mix audio tracks into one file *(experimental)* | [Apps](guide/apps.md) |
| Create recurring routines and reusable workflows | [Workflow examples](guide/workflow-examples.md) |
| Understand the MCP design and available tools | [Two-tool architecture](guide/two-tool-architecture.md) |
| Extend Nexus with downloadable apps | [Apps](guide/apps.md) |

## Prompt For Your Agent

If you want another agent to walk you through setup, paste this:

```text
Help me set up Nexus for Obsidian and guide me step by step.

Use these docs as the source of truth:
- README: https://github.com/ProfSynapse/claudesidian-mcp/blob/main/README.md
- Provider setup: https://github.com/ProfSynapse/claudesidian-mcp/blob/main/guide/provider-setup.md
- MCP setup: https://github.com/ProfSynapse/claudesidian-mcp/blob/main/guide/mcp-setup.md
- Recommended system prompt: https://github.com/ProfSynapse/claudesidian-mcp/blob/main/guide/recommended-system-prompt.md
- Native chat guide: https://github.com/ProfSynapse/claudesidian-mcp/blob/main/guide/native-chat.md

Start by figuring out whether I want native chat inside Obsidian, an external MCP agent, or both. Ask for my OS and the agent I want to use if that matters. Then walk me through the exact setup path, one step at a time.

When a config file needs to be edited, show the exact snippet with my vault path inserted. Do not invent config formats or skip restart/reload steps. If multiple setup paths are possible, recommend the simplest one first.
```

## More Guides

- [Workspace memory](guide/workspace-memory.md)
- [Task management](guide/task-management.md)
- [Semantic search](guide/semantic-search.md)
- [Native chat](guide/native-chat.md)
- [Inline editing](guide/inline-editing.md)
- [Apps](guide/apps.md)
- [Workflow examples](guide/workflow-examples.md)
- [Two-tool architecture](guide/two-tool-architecture.md)

## Multi-Device Sync

Nexus stores conversations, workspaces, and tasks as JSONL files. These files now live inside the plugin directory at `.obsidian/plugins/<plugin-folder>/data/`, which Obsidian Sync includes automatically.

On first launch after updating, Nexus copies existing data from the legacy `.nexus/` folder into the plugin directory. The `.nexus/` folder is kept as a fallback and is never deleted automatically.

The SQLite cache (`cache.db`) is local-only and rebuilt from JSONL on each device — it is not synced.

**Mobile tip**: If your vault finishes syncing after Nexus has already loaded, run the command palette action **Nexus: Refresh synced data** to pick up the latest files.

## Development

```bash
npm install
npm run dev
npm run build
npm run test
npm run lint
```

## License

MIT. See [LICENSE](LICENSE).
