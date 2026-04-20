# Connecting Nexus to AI Agents

Nexus works with any tool that supports the Model Context Protocol (MCP). Below are setup instructions for each major agent. All of them use the same server entry — just the config format differs.

**Requires**: [Node.js](https://nodejs.org/) v18+ installed on your machine.

**The server entry** you'll be adding everywhere:
- **Command**: `node`
- **Arg**: `/path/to/Vault/.obsidian/plugins/nexus/connector.js`

Replace `/path/to/Vault/` with the actual path to your Obsidian vault.

---

## Quick Reference

| Tool | Config File | Top-Level Key | Format | Restart? |
|------|-------------|---------------|--------|----------|
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` | JSON | Yes (full quit) |
| Claude Code (CLI) | `.mcp.json` | `mcpServers` | JSON | No (auto) |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.name]` | **TOML** | No |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | JSON | No |
| GitHub Copilot (VS Code) | `.vscode/mcp.json` | **`servers`** | JSON | Maybe |
| Cline | `cline_mcp_settings.json` | `mcpServers` | JSON | No (auto) |
| Roo Code | `cline_mcp_settings.json` or `.roo/mcp.json` | `mcpServers` | JSON | No |
| Cursor | `.cursor/mcp.json` | `mcpServers` | JSON | Yes |
| Windsurf | `mcp_config.json` | `mcpServers` | JSON | Yes (Cascade) |

---

## Claude Desktop

**Config file**: `claude_desktop_config.json`

**Location**:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

**How to open it**: Claude Desktop &rarr; Settings &rarr; Developer &rarr; Edit Config (creates the file if it doesn't exist).

**First MCP server**:
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

**Adding to existing servers** — add a new entry inside `mcpServers`:
```json
{
  "mcpServers": {
    "some-other-server": { "..." : "..." },
    "nexus": {
      "command": "node",
      "args": ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"]
    }
  }
}
```

Fully quit and relaunch Claude Desktop after saving.

---

## Claude Code (CLI)

**Easiest method** — run this in your terminal:
```bash
claude mcp add nexus -- node /path/to/Vault/.obsidian/plugins/nexus/connector.js
```

Add `--scope user` to make it available across all projects, or `--scope project` to share via `.mcp.json`.

**Manual `.mcp.json`** (in project root):
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

No restart needed — Claude Code picks up changes automatically. Use `/mcp` inside Claude Code to check server status.

---

## OpenAI Codex CLI

**Config file**: `~/.codex/config.toml` (user-level) or `.codex/config.toml` (project-level)

**Note**: Codex uses TOML, not JSON.

**CLI method**:
```bash
codex mcp add nexus -- node /path/to/Vault/.obsidian/plugins/nexus/connector.js
```

**Manual TOML**:
```toml
[mcp_servers.nexus]
command = "node"
args = ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"]
```

**Adding to existing servers** — add another `[mcp_servers.name]` block:
```toml
[mcp_servers.some-other-server]
command = "npx"
args = ["-y", "some-package"]

[mcp_servers.nexus]
command = "node"
args = ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"]
```

---

## Gemini CLI

**Config file**: `~/.gemini/settings.json` (user-level) or `.gemini/settings.json` (project-level)

**First MCP server**:
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

**Adding to existing** — add inside the existing `mcpServers` object.

---

## GitHub Copilot (VS Code)

**Config file**: `.vscode/mcp.json` (workspace) or via Command Palette &rarr; "MCP: Open User Configuration" (global)

**Important**: Copilot uses `"servers"` as the top-level key, not `"mcpServers"`.

**First MCP server**:
```json
{
  "servers": {
    "nexus": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"]
    }
  }
}
```

**Adding to existing** — add inside the existing `servers` object.

You can also add servers via Command Palette &rarr; "MCP: Add Server".

---

## Cline (VS Code)

**Config file**: `cline_mcp_settings.json`

**Location**:
- **macOS**: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Windows**: `%APPDATA%/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
- **Linux**: `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

**How to open it**: Click the MCP Servers icon in Cline's top nav &rarr; Configure MCP Servers.

**First MCP server**:
```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

**Adding to existing** — add inside the existing `mcpServers` object.

Cline auto-detects config changes — no restart needed.

---

## Roo Code (VS Code)

**Config file**: `cline_mcp_settings.json` (global) or `.roo/mcp.json` (project-level)

**Global location**:
- **macOS**: `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`
- **Windows**: `%APPDATA%/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`
- **Linux**: `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json`

**How to open it**: Server icon in Roo Code window &rarr; Edit Global MCP.

**First MCP server**:
```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/path/to/Vault/.obsidian/plugins/nexus/connector.js"],
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

**Project-level `.roo/mcp.json`** — same format, overrides global when names match.

---

## Cursor

**Config file**: `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)

**First MCP server**:
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

**Adding to existing** — add inside the existing `mcpServers` object.

You can also add via Settings &rarr; Tools & MCP &rarr; New MCP Server.

Restart Cursor after saving. Note: Cursor has an approximate 40-tool limit across all enabled MCP servers.

---

## Windsurf

**Config file**: `mcp_config.json`

**Location**:
- **macOS/Linux**: `~/.codeium/windsurf/mcp_config.json`
- **Windows**: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`

**First MCP server**:
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

**Adding to existing** — add inside the existing `mcpServers` object.

Make sure MCP is enabled in Windsurf Settings &rarr; Cascade section. Restart Cascade after saving. Note: Windsurf has a 100-tool limit across all MCP servers.

---

## Multiple Vaults

Each vault runs its own Nexus MCP server. Add one entry per vault with a unique name:

```json
{
  "mcpServers": {
    "nexus-work": {
      "command": "node",
      "args": ["/path/to/Work Vault/.obsidian/plugins/nexus/connector.js"]
    },
    "nexus-personal": {
      "command": "node",
      "args": ["/path/to/Personal Vault/.obsidian/plugins/nexus/connector.js"]
    }
  }
}
```

Obsidian must be open with the vault loaded for its server to be reachable.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Server not connecting | Make sure Obsidian is open and the vault is loaded |
| "node" not found | Install [Node.js](https://nodejs.org/) v18+ and make sure it's in your PATH |
| Config changes not taking effect | Restart the tool (some auto-reload, some don't — see table above) |
| Silent failure (Cursor) | Make sure your JSON has the `mcpServers` root key — Cursor won't error if it's missing |
| Too many tools (Cursor/Windsurf) | Cursor has a ~40 tool limit, Windsurf has 100 — Nexus's two-tool architecture keeps you well under both |
