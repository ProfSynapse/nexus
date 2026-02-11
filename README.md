![Nexus Obsidian Banner](https://picoshare-production-7223.up.railway.app/-vXLL7jFB53/nexus%20obsidian.png)

[![Release](https://img.shields.io/github/v/release/ProfSynapse/claudesidian-mcp?label=release)](https://github.com/ProfSynapse/claudesidian-mcp/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-6f42c1)](https://obsidian.md/plugins)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)](package.json)

# Nexus MCP for Obsidian

Nexus turns your Obsidian vault into an MCP-enabled workspace. It exposes safe, structured tools that AI copilots can call to read/write notes, manage folders, run searches, and maintain long-term memory—all while keeping data local to your vault.

> Nexus is the successor to Claudesidian. Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work.

---

## Highlights

- **Two-Tool Architecture** – Just 2 MCP tools (`getTools` + `useTools`) replace 40+ individual tools, reducing upfront token cost by ~95%.
- **Native Chat View** – Stream tool calls, branch conversations, and manage models directly inside Obsidian.
- **Inline AI Editing** – Select text, right-click or use hotkey, and transform it with AI instructions.
- **Workspace Memory** – Workspaces, states, and traces in `.nexus/` (sync-friendly JSONL + local SQLite cache).
- **Local Semantic Search** – Desktop-only embeddings via sqlite-vec vector search—no external API calls. Search notes and conversation history.
- **Full Vault Operations** – Create, read, update, delete notes, folders, frontmatter, and batch edits.
- **Multi-Provider Support** – Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, Perplexity, Requesty, plus local servers (Ollama, LM Studio).
- **Multi-Vault Ready** – Independent MCP instances per vault.

**Platform Notes**
| Feature | Desktop | Mobile |
|---------|---------|--------|
| Native Chat | ✅ | ✅ |
| Inline AI Editing | ✅ | ✅ (command palette only) |
| MCP Bridge (Claude Desktop) | ✅ | — |
| Local Providers (Ollama/LM Studio) | ✅ | — |
| Semantic Embeddings | ✅ | — |
| Cloud Providers | ✅ | ✅ (fetch-based only) |

---

## Two-Tool Architecture

Nexus exposes exactly **2 tools** to MCP clients like Claude Desktop:

| Tool | Purpose |
|------|---------|
| `toolManager_getTools` | **Discovery** – Returns schemas for requested agents/tools |
| `toolManager_useTools` | **Execution** – Runs tools with unified context |

### Why This Matters

- **~95% token reduction** in upfront schemas (~15,000 → ~500 tokens)
- Works great with small context window models (local LLMs)
- Context-first design captures memory/goal for every operation

### Context Schema

Every `useTools` call includes context that helps maintain continuity:

```typescript
{
  workspaceId: string;   // Scope identifier (name or UUID)
  sessionId: string;     // Session name (system assigns standard ID)
  memory: string;        // Conversation essence (1-3 sentences)
  goal: string;          // Current objective (1-3 sentences)
  constraints?: string;  // Rules/limits (1-3 sentences, optional)
}
```

### Available Agents & Tools (34 total)

| Agent | Purpose | Tools |
|-------|---------|-------|
| **contentManager** | Note reading/editing | read, write, update |
| **storageManager** | File/folder management | list, createFolder, move, copy, archive, open |
| **searchManager** | Search operations | searchContent, searchDirectory, searchMemory |
| **memoryManager** | Workspace/state management | createWorkspace, listWorkspaces, loadWorkspace, updateWorkspace, archiveWorkspace, createState, listStates, loadState |
| **promptManager** | Custom prompts & LLM | listModels, executePrompts, listPrompts, getPrompt, createPrompt, updatePrompt, archivePrompt, generateImage, subagent |
| **canvasManager** | Canvas operations | read, write, update, list |

---

## Install

1. Download the latest release assets: `manifest.json`, `styles.css`, `main.js`, `connector.js`
2. Place them in `.obsidian/plugins/nexus/` (or keep legacy `.obsidian/plugins/claudesidian-mcp/`)
3. Enable **Nexus** in Obsidian Settings → Community Plugins
4. Restart Obsidian after first install

---

## Configure Claude Desktop

Add the Nexus server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nexus-your-vault": {
      "command": "node",
      "args": [
        "/path/to/Vault/.obsidian/plugins/nexus/connector.js"
      ]
    }
  }
}
```

Or use the **one-click setup**: Settings → Nexus → Get Started → MCP Integration → **Add Nexus to Claude**

After adding, fully quit and relaunch Claude Desktop.

---

## Using Native Chat

1. Configure a provider in **Settings → Nexus → Providers**
2. Open chat via ribbon icon or command palette (**Nexus: Open Nexus Chat**)
3. Type `/` for tools, `@` for custom agents, `[[` to link notes
4. Tool calls stream live with collapsible result panels

---

## Inline AI Editing

Edit selected text directly in your notes using AI:

1. **Select text** in any note
2. **Trigger** via:
   - Right-click → **Edit with AI** (requires "Native menus" disabled in Obsidian settings)
   - Command palette → **Edit selection with AI**
3. **Enter instruction** (e.g., "Make this more concise", "Translate to French")
4. **Generate** – Watch streaming preview with cancel option
5. **Review & Apply** – Edit the result, retry, or apply to replace original text

| Feature | Description |
|---------|-------------|
| Model Selection | Dropdown to choose from configured providers |
| Streaming Preview | See AI output as it generates |
| Cancel Support | Stop generation mid-stream |
| Editable Result | Modify AI output before applying |
| Retry | Regenerate with same or new instruction |
| Undo | Standard Ctrl/Cmd+Z after applying |

---

## Workspace Memory

All data lives in `.nexus/` inside your vault:

```
.nexus/
├── conversations/*.jsonl  # Chat history (syncs across devices)
├── workspaces/*.jsonl     # Workspace events
└── cache.db               # SQLite cache (auto-rebuilt, not synced)
```

- Each tool call is tagged to a workspace automatically via context
- Create/load workspaces and save immutable state snapshots via tools or chat UI
- Archive workspaces and states for cold storage (restorable)
- No external database required

---

## Semantic Search

Use `searchManager.searchContent` with `semantic: true` for meaning-based search:

- **Desktop only** – Embeddings run locally via iframe-sandboxed transformers.js
- **Model**: `Xenova/all-MiniLM-L6-v2` (384 dimensions, ~23MB, cached in browser IndexedDB)
- **Vectors**: Stored in `.nexus/cache.db` via sqlite-vec for fast similarity search
- **First run** downloads the model (requires internet); subsequent runs are fully offline
- Watch the status bar for indexing progress; click to pause/resume

### Conversation Memory Search

Use `searchManager.searchMemory` to search across past conversation turns and tool call traces:

| Mode | Scope | Use Case |
|------|-------|----------|
| **Discovery** | Workspace-wide | "What have I discussed about authentication?" |
| **Scoped** | Session + N-turn window | "What did I just ask about this file?" |

- Conversations are chunked into Q&A pairs and embedded in real-time as you chat
- Multi-signal reranking: semantic similarity + recency + session density + note references
- Background backfill indexes existing conversations automatically
- Works with the same local embedding model—no external API calls

---

## Multi-Vault Setup

- Each vault runs its own MCP server with key `nexus-[vault-name]`
- Add one entry per vault in your MCP client config
- Keep vaults open to keep their servers reachable

---

## Security & Privacy

- MCP server binds locally only—no remote listeners
- All file operations stay inside the active vault
- Network calls only for remote LLM providers (per your API keys)
- Embeddings download once, then run fully on-device

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Server not found | Settings → Nexus → Get Started → MCP Integration → **Add Nexus to Claude**, then restart Claude Desktop |
| Pipes not created | Ensure Obsidian is open; Windows uses `nexus_mcp_<vault>` named pipes |
| WebLLM crashes | Currently disabled due to WebGPU bug on Apple Silicon; use Ollama or LM Studio |
| Legacy install | Paths to `.obsidian/plugins/claudesidian-mcp/connector.js` still work |

---

## Development

```bash
npm install        # Install dependencies
npm run dev        # Development build with watch
npm run build      # Production build
npm run test       # Run tests
npm run lint       # Run ESLint
```

See [CLAUDE.md](CLAUDE.md) for architecture details and contribution notes.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

Questions or issues? Open a GitHub issue with your OS, Obsidian version, and any console logs.
