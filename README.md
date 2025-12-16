![Nexus Obsidian Banner](https://picoshare-production-7223.up.railway.app/-vXLL7jFB53/nexus%20obsidian.png)

[![Release](https://img.shields.io/github/v/release/ProfSynapse/claudesidian-mcp?label=release)](https://github.com/ProfSynapse/claudesidian-mcp/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-6f42c1)](https://obsidian.md/plugins)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)](package.json)

# Nexus MCP for Obsidian

Nexus turns your Obsidian vault into an MCP-enabled workspace. It exposes safe, structured tools (agents + modes) that AI copilots can call to read/write notes, manage folders, run searches, and maintain long‑term memory—all while keeping data local to your vault.

> Nexus is the successor to Claudesidian. Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work, but Nexus uses the `nexus_mcp_` socket/pipe prefix (so older Claudesidian connectors need to be updated).

---

## What You Get

- **MCP server for Obsidian** – One server per vault with vault-aware identifiers.
- **Native Chat View** – No external client required; stream tool calls, branch conversations, and manage models from inside Obsidian.
- **Workspace Memory System** – Sessions, traces, and state snapshots stored in your vault under `.nexus/` (sync-friendly JSONL + local SQLite cache).
- **Semantic Search (Embeddings)** – Desktop-only local embeddings + sqlite-vec vector search (via `vaultLibrarian.searchContent` with `semantic: true`).
- **Full Vault Operations** – Create/read/update/delete notes, folders, frontmatter, and batch content edits.
- **Agent-Mode Architecture** – Domain-specific agents with typed modes for predictable tool calling.
- **Multi-vault support** – Independent MCP instances per vault, keyed by sanitized vault name.
- **Cloud + local providers** – Anthropic, OpenAI, Google, Groq, Mistral, OpenRouter, Perplexity, Requesty, plus desktop-local servers (Ollama, LM Studio). _(WebLLM is currently disabled.)_

**Platform notes**
- **Desktop:** Internal chat + external MCP bridge (Claude Desktop) + local providers (Ollama/LM Studio).
- **Mobile:** Internal chat works, but only fetch-based providers (OpenRouter/Requesty/Perplexity); no external MCP bridge.

---

## Install (Fresh)

1. Download the latest release assets:
   - `manifest.json`
   - `styles.css`
   - `main.js`
   - `connector.js`
2. Place them in your vault at `.obsidian/plugins/nexus/`  
   _(Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work; Nexus will detect either.)_
3. Enable **Nexus** in Obsidian Settings → Community Plugins.
4. Restart Obsidian after first install. If using Claude Desktop, fully quit/relaunch it as well.

---

## Upgrade from Claudesidian

- **Plugin folder/id:** New default folder is `nexus`; legacy `claudesidian-mcp` remains valid.
- **Server keys:** Recommended `nexus-[sanitized-vault-name]`; legacy `claudesidian-mcp-[sanitized-vault-name]` entries can be kept (the key is just a client label).
- **Pipes/sockets:** Nexus uses the `nexus_mcp_` prefix. If you’re upgrading, re-point clients to the current `connector.js` (see setup below).
- **Setup helper:** On desktop, use **Settings → Nexus → Get Started → MCP Integration** for one-click Claude Desktop configuration.

---

## Configure Claude Desktop (or any MCP client)

Add/merge the Nexus server entry into your MCP client config (Claude Desktop uses `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nexus-your-vault": {
      "command": "node",
      "args": [
        "C:\\Users\\you\\Vault\\.obsidian\\plugins\\nexus\\connector.js"
      ]
    }
  }
}
```

- Replace the path with your vault location. On macOS/Linux use `/Users/you/Vault/.obsidian/plugins/nexus/connector.js`.
- If you still have the old folder, keep the path pointing at `.obsidian/plugins/claudesidian-mcp/connector.js`.
- For Claude Desktop, Nexus can write this automatically via **Settings → Nexus → Get Started → MCP Integration**.

---

## Using the Native Chat View

1. Configure at least one provider in **Settings → Nexus → Providers**.
2. Open the chat via the ribbon icon or command palette (**Nexus: Open Nexus Chat**).
3. Type `/` to browse tools, `@` to pick custom agents, and `[[` to link notes. Tool calls stream live with results.
4. Choose your provider/model in the chat UI (desktop-only providers won’t appear on mobile).

---

## Workspace Memory at a Glance

- Everything is local: workspaces, sessions, traces, and snapshots live under `.nexus/` (JSONL source-of-truth) with a local SQLite cache at `.nexus/cache.db`.
- Each tool call is tagged to a workspace and session automatically; you can create/load via tools or the UI.
- No external vector DB is required; embeddings and semantic search use `.nexus/cache.db` (SQLite + sqlite-vec).

---

## Semantic Search (Embeddings)

- Use `vaultLibrarian.searchContent` with `semantic: true` for meaning-based search; use `semantic: false` for keyword/fuzzy snippets.
- On desktop, Nexus indexes notes in the background and stores vectors in `.nexus/cache.db` (watch the status bar for progress; click to pause/resume).
- First run may require internet access to download the local embedding model; it is cached locally afterwards.

---

## Multi-Vault Tips

- Each vault runs its own MCP server and has its own key (`nexus-[vault-name]`).
- Claude Desktop can list multiple servers; just add one entry per vault in `mcpServers`.
- Keep each vault open to keep its server reachable.

---

## Security & Privacy

- MCP server binds locally; no remote listeners are opened.
- All file operations stay inside the active vault.
- Network calls happen only when you use remote LLM providers (per provider API keys) or local providers running on `localhost`.
- Embeddings download the local model once (desktop only) and then run fully on-device; the model is cached locally.

---

## Development

- Build: `npm run build`
- Test: `npm test` (if configured)
- Typecheck only: `tsc --noEmit`

---

## Troubleshooting

- **Server not found:** In Obsidian, go to **Settings → Nexus → Get Started → MCP Integration** and click **Add Nexus to Claude**, then restart Claude Desktop.
- **Pipes not created:** Ensure Obsidian is open for that vault; Windows named pipes use the `nexus_mcp_<vault>` prefix.
- **Legacy installs:** If your config still points at `.obsidian/plugins/claudesidian-mcp/connector.js`, that’s OK as long as it’s the current connector.

Enjoy building with Nexus! If you hit issues, open a GitHub issue on this repo with your OS, Obsidian version, and any console logs.
