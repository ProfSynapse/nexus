![Nexus Obsidian Banner](https://picoshare-production-7223.up.railway.app/-vXLL7jFB53/nexus%20obsidian.png)

[![Release](https://img.shields.io/github/v/release/ProfSynapse/claudesidian-mcp?label=release)](https://github.com/ProfSynapse/claudesidian-mcp/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-6f42c1)](https://obsidian.md/plugins)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)](package.json)

# Nexus MCP for Obsidian

Nexus gives AI agents like Claude full access to your Obsidian vault — so you can manage your entire knowledge base through natural conversation while keeping everything local.

**Everything is natural language first.** Notes, folders, workspaces, workflows, projects, tasks, search, image generation — the AI can create, read, update, and manage all of it just by you asking. There's also a settings UI for when you prefer clicking, but you never have to leave the conversation.

> Nexus is the successor to Claudesidian. Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work.

---

## Get Started

### 1. Install the Plugin

1. Download the latest [release](https://github.com/ProfSynapse/claudesidian-mcp/releases): `manifest.json`, `styles.css`, `main.js`, `connector.js`
2. Place them in `.obsidian/plugins/nexus/` (or keep legacy `.obsidian/plugins/claudesidian-mcp/`)
3. Enable **Nexus** in Settings &rarr; Community Plugins
4. Restart Obsidian

### 2. Set Up a Provider (for Native Chat)

The built-in chat works right away with no extra software. Just add an API key in **Settings &rarr; Nexus &rarr; Providers** and start chatting inside Obsidian. Supports Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, Perplexity, Requesty, Ollama, and LM Studio.

### 3. Connect an External AI Agent (optional)

Nexus works as an MCP server with Claude Desktop, Claude Code, Codex CLI, Gemini CLI, GitHub Copilot, Cline, Roo Code, Cursor, Windsurf, and any other MCP-compatible tool. Requires [Node.js](https://nodejs.org/) (v18+) on your machine. The native chat inside Obsidian works fine without this.

**Quick setup for Claude Desktop**:

1. Open Claude Desktop &rarr; **Settings** &rarr; **Developer** &rarr; **Edit Config**
2. Add Nexus to the config (or use one-click: Settings &rarr; Nexus &rarr; Get Started &rarr; **Add Nexus to Claude**):

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"]
    }
  }
}
```

3. Fully quit and relaunch Claude Desktop

[Setup guides for all supported agents &rarr;](guide/mcp-setup.md)

#### Add a system prompt (recommended)

For best results, give your AI agent some guidance on how to use your vault:

> At the start of every conversation, list workspaces and load the appropriate one. If one doesn't exist, create one. If you lost context from compaction, reload the workspace. Always call getTools before useTools — never guess parameters.

[Full recommended system prompt &rarr;](guide/recommended-system-prompt.md)

---

## What Can You Do?

Just tell the AI what you want in plain language. Everything below works through Claude Desktop or the built-in native chat — no menus or special syntax required.

### Read, write, and organize your vault

> "Summarize my meeting notes from this week"

> "Create a new note called 'Project Roadmap' with sections for Q1 and Q2"

> "Move everything in my Inbox folder to the Archive"

### Set up and manage workspaces

Workspaces scope your AI sessions to a project. The AI creates them, loads them, saves states, and manages everything inside them — you just ask.

> "Create a workspace called 'Thesis Research'"

> "Save the current state as 'Literature Review Complete'"

[Details &rarr;](guide/workspace-memory.md)

### Create and schedule workflows

Workflows are reusable routines that live inside a workspace. The AI can create them, bind prompts, set schedules, and trigger them — all through conversation.

> "Add a daily workflow that summarizes notes I modified yesterday"

> "Run the Morning Briefing workflow now"

[Details &rarr;](guide/workspace-memory.md#workflows)

### Manage projects and tasks

Create projects, add tasks with dependencies, update status, assign work, set due dates — the AI handles the full lifecycle. There's also a settings UI if you prefer, but conversation is the primary interface.

> "Create a project called 'Website Relaunch' and add tasks for design, implementation, and testing"

> "What can I work on next?"

[Details &rarr;](guide/task-management.md)

### Search by meaning

Find notes by what they're about, not just keywords. Search past conversations too. All local — no external API calls.

> "Find everything I've written about behavioral economics"

> "What did we discuss about the API design last week?"

[Details &rarr;](guide/semantic-search.md)

### Build custom prompts

Create reusable prompts with specific instructions, bind them to workspaces or workflows, and invoke them anytime. The AI can create, edit, list, and run prompts through conversation.

> "Create a prompt called 'Code Review' that analyzes a note for bugs and suggests improvements"

> "Run my 'Weekly Reflection' prompt"

In the native chat, type `@` to quickly browse and invoke your saved prompts from the keyboard.

### Edit text inline

Select text in any note, right-click &rarr; **Edit with AI**, and transform it with a natural language instruction. Streaming preview, retry, and undo built in.
[Details &rarr;](guide/inline-editing.md)

### Chat inside Obsidian

Open the built-in chat (ribbon icon or command palette) to talk to any configured LLM with full vault access. Type `/` for tools, `@` for custom prompts, `[[` to link notes.
[Details &rarr;](guide/native-chat.md)

### Extend with apps

Install app plugins like ElevenLabs to add capabilities. The AI uses them just like any other tool.

> "Convert my blog post note to speech and save it to Audio/"

[Details &rarr;](guide/apps.md)

[See more examples of what you can do &rarr;](guide/workflow-examples.md)

---

## Platform Support

| Feature | Desktop | Mobile |
|---------|---------|--------|
| Native Chat | Yes | Yes |
| Inline AI Editing | Yes | Yes (command palette) |
| MCP Bridge (Claude Desktop) | Yes | — |
| Local Providers (Ollama/LM Studio) | Yes | — |
| Semantic Embeddings | Yes | — |
| Cloud Providers | Yes (real streaming) | Yes (buffered) |

---

## How It Works

Nexus uses a **two-tool architecture** — instead of exposing 45+ tools upfront, it gives the AI just two: one to discover available tools, and one to execute them. This keeps things fast and works well even with smaller models.

All your data stays in a `.nexus/` folder inside your vault as sync-friendly JSONL files with a local SQLite cache.

[Architecture details &rarr;](guide/two-tool-architecture.md) | [Full tool reference &rarr;](docs/TOOL_REFERENCE.md)

---

## Security & Privacy

- MCP server runs locally only — no remote connections
- All file operations stay inside your vault
- Network calls only for LLM providers you configure
- Embeddings download once, then run fully on-device

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Server not found in Claude | Settings &rarr; Nexus &rarr; Get Started &rarr; **Add Nexus to Claude**, restart Claude Desktop |
| Pipes not created | Make sure Obsidian is open (Windows uses named pipes) |
| Legacy install path | `.obsidian/plugins/claudesidian-mcp/connector.js` still works |

---

## Development

```bash
npm install        # Install dependencies
npm run dev        # Development build with watch
npm run build      # Production build
npm run test       # Run tests
npm run lint       # Run ESLint
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

Questions? [Open an issue](https://github.com/ProfSynapse/claudesidian-mcp/issues) with your OS, Obsidian version, and any console logs.
