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

- Install the latest release from [GitHub Releases](https://github.com/ProfSynapse/claudesidian-mcp/releases): `manifest.json`, `styles.css`, and `main.js`
- Put them in `.obsidian/plugins/nexus/` and enable **Nexus** in Obsidian
- Native chat in Obsidian: [Provider setup](guide/provider-setup.md) and [Native chat guide](guide/native-chat.md) for chat, live voice, read-aloud, and built-in audio/video generation
- External agent over MCP: use **Nexus settings -> Get started -> External agents** to create `connector.js` and update Claude Desktop, then see [MCP setup guide](guide/mcp-setup.md) and [Recommended system prompt](guide/recommended-system-prompt.md)
- External agent over CLI (no MCP config): install the `nexus` command from **Get started -> External agents -> Local CLI** so shell agents (Claude Code, Cursor, Codex) can drive your vault directly — see the [Nexus CLI guide](guide/nexus-cli.md). Installation is user-triggered, writes only outside the vault, and on Windows adds the Nexus directory to the current user's PATH without administrator rights; uninstall removes only entries Nexus recorded as its own.
- Optional desktop features: [Semantic search](guide/semantic-search.md), [Adaptive search](guide/adaptive-search.md), and [Apps and integrations](guide/apps.md)

Native chat works on desktop and mobile. MCP clients, local desktop providers, and semantic search are desktop-only.

## Mobile Support (Experimental)

Native chat works on mobile (iOS and Android). Desktop-only features gracefully skip loading on mobile -- they will not appear or cause errors.

| Feature | Mobile | Desktop |
|---------|--------|---------|
| Native chat | Yes | Yes |
| Workspace memory and tasks | Yes | Yes |
| Skills (author and load) | Yes | Yes |
| MCP clients (Claude Desktop, Cursor, etc.) | No | Yes |
| Local CLI bridge (`nexus` command) | No | Yes |
| Semantic search (local embeddings) | No | Yes |
| Ingestion (PDF, audio, DOCX) | No | Yes |
| Composer and Web Tools | No | Yes |
| Data Analysis (Python over CSV/Excel) | No | Yes |

Mobile support is new and may have bugs. Please [report issues on GitHub](https://github.com/ProfSynapse/nexus/issues).

## Use Cases

| If you want to... | Start here |
|---|---|
| Connect Claude Desktop, Codex CLI, Gemini CLI, Cursor, Cline, or another MCP client | [MCP setup](guide/mcp-setup.md) |
| Drive your vault from the shell with Claude Code, Cursor, or Codex — no MCP config | [Nexus CLI](guide/nexus-cli.md) |
| Configure built-in chat providers inside Obsidian | [Provider setup](guide/provider-setup.md) |
| Use live voice, read notes aloud, or save spoken audio back into your notes | [Native chat](guide/native-chat.md) |
| Generate voice audio or text-to-video files directly into your vault | [Native chat](guide/native-chat.md) |
| Give your agent better instructions for using Nexus | [Recommended system prompt](guide/recommended-system-prompt.md) |
| Manage long-running work with persistent workspace context | [Workspace memory](guide/workspace-memory.md) |
| Track projects, tasks, blockers, and dependencies | [Task management](guide/task-management.md) |
| Search notes and past conversations by meaning | [Semantic search](guide/semantic-search.md) |
| Have search learn from the notes you actually open, fully on-device | [Adaptive search](guide/adaptive-search.md) |
| Edit selected text directly in notes | [Inline editing](guide/inline-editing.md) |
| Open webpages in Obsidian and save them as Markdown, PNG, or PDF *(experimental)* | [Apps](guide/apps.md) |
| Convert PDFs and audio files to Markdown notes — right-click in vault or auto on add *(experimental)* | [Apps](guide/apps.md) |
| Merge PDFs, concat markdown, or mix audio tracks into one file *(experimental)* | [Apps](guide/apps.md) |
| Author and load reusable agent Skills straight from your vault | [Apps](guide/apps.md) |
| Run Python/pandas analysis over your vault's CSV and Excel data *(experimental, desktop)* | [Apps](guide/apps.md) |
| Create recurring routines and reusable workflows | [Workflow examples](guide/workflow-examples.md) |
| Understand the MCP design and available tools | [Two-tool architecture](guide/two-tool-architecture.md) |
| Extend Nexus with optional apps | [Apps](guide/apps.md) |

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
- [Adaptive search](guide/adaptive-search.md)
- [Native chat](guide/native-chat.md)
- [Inline editing](guide/inline-editing.md)
- [Apps](guide/apps.md)
- [Workflow examples](guide/workflow-examples.md)
- [Two-tool architecture](guide/two-tool-architecture.md)
- [Nexus CLI](guide/nexus-cli.md)

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
