![Nexus Obsidian Banner](https://picoshare-production-7223.up.railway.app/-vXLL7jFB53/nexus%20obsidian.png)

[![Release](https://img.shields.io/github/v/release/ProfSynapse/claudesidian-mcp?label=release)](https://github.com/ProfSynapse/claudesidian-mcp/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.6%2B-6f42c1)](https://obsidian.md/plugins)
[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)](package.json)

# Nexus MCP for Obsidian

Nexus turns your Obsidian vault into an MCP-enabled workspace. It exposes safe, structured tools (agents + modes) that AI copilots can call to read/write notes, manage folders, run searches, and maintain long-term memory - all while keeping data local to your vault.

> Nexus is the successor to Claudesidian. Backward compatibility is preserved: existing `claudesidian-mcp` folders, server keys, and pipes will still work.

---

## What You Get

- **MCP server for Obsidian** - One server per vault with vault-aware identifiers.
- **Native Chat View** - No external client required; stream tool calls, branch conversations, and manage models from inside Obsidian.
- **Workspace Memory System** - Sessions, traces, and state snapshots stored in your vault (`.workspaces`, `.conversations`).
- **Full Vault Operations** - Create/read/update/delete notes, folders, frontmatter, and batch content edits.
- **Agent-Mode Architecture** - Domain-specific agents with typed modes for predictable tool calling.
- **Multi-vault support** - Independent MCP instances per vault, keyed by sanitized vault name.
- **Local + cloud models** - WebLLM (Nexus 7B) plus Anthropic, OpenAI, Google, Groq, Mistral, Ollama, LM Studio, OpenRouter, Perplexity, Requesty.

---

## Install (Fresh)

1. Download the latest release assets:
   - `manifest.json`
   - `styles.css`
   - `main.js`
   - `connector.js`
2. Place them in your vault at `.obsidian/plugins/nexus/`
   _(Legacy installs in `.obsidian/plugins/claudesidian-mcp/` still work; Nexus will detect either.)_
3. Enable **Nexus** in Obsidian Settings -> Community Plugins.
4. Restart Obsidian after first install. If using Claude Desktop, fully quit/relaunch it as well.

---

## Upgrade from Claudesidian

- **Plugin folder/id:** New default folder is `nexus`; legacy `claudesidian-mcp` remains valid.
- **Server keys:** New format `nexus-[sanitized-vault-name]`; legacy `claudesidian-mcp-[sanitized-vault-name]` is auto-detected and migrated when possible.
- **Pipes/sockets:** New prefix `nexus_mcp_`; legacy `claudesidian_mcp_` still accepted.
- **Config generator:** The settings modal `.mcp.json` generator writes Nexus keys but will remove stale legacy entries only if they point to the same vault.

---

## Configure Claude Desktop (or any MCP client)

Add/merge the Nexus server entry into your `claude_desktop_config.json` (or `.mcp.json` for other clients):

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
- If you still have the old folder, `claudesidian-mcp` keys remain valid; Nexus resolves both.
- In Obsidian -> Nexus settings, use **Generate MCP Config** to update `.mcp.json` in the vault root without overwriting other servers.

---

## Using the Native Chat View

1. Enable **Settings -> Nexus MCP -> Agent Management -> AI Chat**.
2. Open the chat via ribbon icon or command palette ("Open AI Chat").
3. Type `/` to browse tools, `@` to pick custom agents, and `[[` to link notes. Tool calls stream live with results.
4. Model switching (cloud/local) happens inside the chat UI; Nexus preloads the WebLLM model when selected.

---

## Workspace Memory at a Glance

- Everything is local: workspaces, sessions, traces, and snapshots live under `.workspaces/` and `.conversations/`.
- Each tool call is tagged to a workspace and session automatically; you can create/load via tools or the UI.
- No external vector DB is required; Nexus uses JSON storage with search utilities built in.

---

## Multi-Vault Tips

- Each vault runs its own MCP server and has its own key (`nexus-[vault-name]`).
- Claude Desktop can list multiple servers; just add one entry per vault in `mcpServers`.
- Keep each vault open to keep its server reachable.

---

## Security & Privacy

- MCP server binds locally; no remote listeners are opened.
- All file operations stay inside the active vault.
- Network calls happen only when you use remote LLM providers (per provider API keys).
- Local WebLLM Nexus model runs entirely on-device with WebGPU.

---

## Development

- Build: `npm run build`
- Test: `npm test` (if configured)
- Typecheck only: `tsc --noEmit`

---

## Troubleshooting

- **Server not found:** Re-run "Generate MCP Config" in the Nexus settings tab; confirm the connector path matches your vault.
- **Pipes not created:** Ensure Obsidian is open for that vault; Windows named pipes use the `nexus_mcp_<vault>` prefix.
- **Legacy clients:** Keep `claudesidian-mcp` entries if existing clients reference them; Nexus will serve both ids.

Enjoy building with Nexus! If you hit issues, open a GitHub issue on the Nexus repo with your OS, Obsidian version, and any console logs.

---

## Developer Notes (Repo Map)

- Folder READMEs: each folder under `src/` (and `scripts/`) contains a short `README.md` describing responsibilities and local improvement ideas.
- Cross-cutting findings: `CODEBASE_AUDIT.md`.
- Regenerate folder READMEs: `node scripts/generate-folder-readmes.mjs`
