# Nexus local CLI (`nexus`)

Drive a running Nexus (Obsidian) vault from the shell — for external coding
agents (Claude Code, Codex, Cursor…) — with **no MCP configuration**. The CLI is
a thin client over the same local socket `connector.js` uses; the plugin server
is unchanged.

Design & rationale: [`docs/plans/local-cli-agent-bridge-plan.md`](plans/local-cli-agent-bridge-plan.md).

## Install

Obsidian → Settings → Nexus → Get Started → External agents → **Local CLI (no
MCP required)** → pick your agents → **Install CLI**. It:

- writes the CLI to a machine-global location and puts `nexus` on your PATH
  (macOS/Linux symlink in `~/.local/bin`; Windows `nexus.cmd` in
  `%LOCALAPPDATA%\nexus` with an automatic per-user PATH entry);
- wires the CLI into the agents you pick: a Claude Code skill
  (`~/.claude/skills/nexus`), a Cursor skill (`~/.cursor/skills/nexus`), and/or
  a Codex `AGENTS.md` pointer — defaults to whatever it detects on your machine;
- is fully reversible via **Uninstall**.

Requires Node.js 18 or newer on the shell's PATH; installation stops with an
actionable error when that runtime is unavailable. Obsidian must be **open** for the target
vault (the CLI bridges to the live process).

## Commands

```
nexus tools [selector...]           Discover tools. Drill down as far as you want:
                                      nexus tools                    all agents
                                      nexus tools storage            one agent (compact)
                                      nexus tools storage list       one tool, full arg schema
                                      nexus tools "storage list, content read"   several at once
nexus use "<command>" [context]     Run a CLI-style tool command
nexus vaults                        List open vaults
nexus doctor [--vault <name>]       Connect + MCP handshake + tools/list
nexus --help                        Full usage
```

### `use` context (required)

```
nexus use "content read --path Daily/2026-07-17.md" \
  --memory "reviewing this week's notes" \
  --goal "read today's daily note"
```

`--memory` and `--goal` are **required** — Nexus enforces the context contract
and rejects calls without them. Optional: `--workspace <id>` (default
`default`), `--session <name>` (default `nexus-cli`; reuse one name per task),
`--constraints <text>`, `--json` (raw JSON-RPC result).

## Choosing a vault

The vault name lives in the socket name, so selection happens at call time:

1. `--vault <name>` — the human vault name works (`--vault "My Notes"`).
2. `NEXUS_VAULT` env var — pin a vault for a shell/session.
3. exactly one vault open → used automatically.
4. multiple open, none specified → error listing them (run `nexus vaults`).

## Platform notes

| Platform | Transport | Install |
|----------|-----------|---------|
| macOS / Linux | unix socket `/tmp/nexus_mcp_<vault>.sock` | `~/.local/bin/nexus` symlink; `~/.claude/skills/nexus` symlink |
| Windows | named pipe `\\.\pipe\nexus_mcp_<vault>` | `%LOCALAPPDATA%\nexus\nexus.cmd` (user PATH is updated automatically); skill **copied** (no symlink) |

- On macOS, `~/.local/bin` is often not on PATH by default — the installer warns
  if so; add it to your shell profile.
- On Windows, the CLI enumerates the local named-pipe namespace through
  PowerShell. If local policy blocks enumeration, pass `--vault <name>` or set
  `NEXUS_VAULT`; direct connections do not require enumeration.
- Nexus never replaces a same-named command that resolves earlier on PATH, or
  an existing unmarked `~/.claude/skills/nexus` / `~/.cursor/skills/nexus`
  directory. The settings status reports command shadowing so the conflict is
  visible without deleting or reordering another tool.

## Troubleshooting

- **"No open Nexus vaults" / connect error** — Obsidian isn't open for that
  vault, or Nexus isn't loaded. Open it, then retry.
- **`nexus: command not found`** — restart the terminal after installing. If it
  still fails, PATH doesn't include the install dir (macOS `~/.local/bin`,
  Windows `%LOCALAPPDATA%\nexus`), or `node` isn't installed.
- **"Multiple vaults open"** — run `nexus vaults`, then pass `--vault <name>`.
- **Rejected for missing memory/goal** — every `use` needs `--memory` and
  `--goal`.
