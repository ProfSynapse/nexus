# Nexus local CLI (`nexus`)

Drive a running Nexus (Obsidian) vault from the shell — for external coding
agents (Claude Code, Codex, Cursor…) — with **no MCP configuration**. The CLI is
a thin client over the same local socket `connector.js` uses; the plugin server
is unchanged.

Design & rationale: [`docs/plans/local-cli-agent-bridge-plan.md`](../docs/plans/local-cli-agent-bridge-plan.md).

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

After that explicit installation, plugin updates automatically reconcile the
already-installed Nexus CLI, skill, playbooks, and managed agent copies with the
new plugin build. Reconciliation does nothing when the CLI is not installed and
does not claim or replace foreign commands or unmarked skill directories.

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
nexus use [context] -- <command>    Run a CLI-style tool command
nexus vaults                        List open vaults
nexus doctor [--vault <name>]       Connect + MCP handshake + tools/list
nexus --help                        Full usage
```

### `use` context (required)

```
nexus use \
  --memory "reviewing this week's notes" \
  --goal "read today's daily note" \
  -- content read --path Daily/2026-07-17.md --start-line 1
```

`--memory` and `--goal` are **required** — Nexus enforces the context contract
and rejects calls without them. Optional: `--workspace <id>` (default
`default`), `--session <name>` (default `nexus-cli`; reuse one name per task),
`--constraints <text>`, `--json` (raw JSON-RPC result).

The `--` delimiter separates CLI context from the tool command. Values after it
are ordinary shell arguments, so a multiword value needs only one quote layer:

```powershell
nexus use --memory "resuming research" --goal "load the workspace" -- memory load-workspace "NeuroAI Mapping" --limit 1
```

The legacy `nexus use "<command>" ...` form remains supported. If Windows
PowerShell splits a legacy command at nested double quotes, Nexus rejects it
with a structured-form example instead of executing a truncated request.
Use `--dry-run` before the delimiter to print the reconstructed request without
opening a vault connection or executing a tool.

### Multiline content

On Windows, a `.cmd` wrapper cannot reliably forward a multiline argument
through `%*`. Embedded quote layers can also be altered before Node receives
them. For Markdown, YAML frontmatter, wikilinks, or other large text, keep the
content out of shell arguments with a CLI-only transport flag. **Any**
value-taking tool flag has a transport form — `--<flag>-stdin` reads the value
from standard input, `--<flag>-file <local-path>` reads it from a file:

```powershell
Get-Content -Raw .\note.md |
  nexus use --memory "importing a note" --goal "write the note" -- content write --path Notes/Imported.md --content-stdin

nexus use --memory "importing a note" --goal "write the note" -- content write --path Notes/Imported.md --content-file ".\note.md"

nexus use --memory "saving a checkpoint" --goal "save state" -- memory create-state --name "checkpoint" --conversation-context-file .\ctx.md --active-task "refactor" --active-files "a.ts" --next-steps "run tests"
```

Transport flags must appear after the `--` delimiter. They are converted to the
tool's normal flag value inside the CLI. Use at most one `-stdin` transport per
command (standard input can only be read once); several `-file` transports may
coexist; do not also pass the same flag directly. `--<flag>-file` reads a local
filesystem path; the destination passed to the Nexus tool remains
vault-relative.

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

- On macOS, `~/.local/bin` is often not on PATH by default. Nexus checks by asking
  your login shell to resolve `nexus`, so the settings status reflects what your
  terminal will actually do — not what Obsidian happened to inherit. When it can't
  be resolved, settings shows the exact line to add and which profile file it goes
  in (`~/.zshrc`, `~/.bash_profile`, fish's `config.fish`), with a Copy button.
  Nexus never edits your shell profile itself.
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
  Windows `%LOCALAPPDATA%\nexus`), or `node` isn't installed. Check **Get started
  -> External agents -> Local CLI**: if it says "not yet on your PATH", it shows
  the line to paste and where. An account with no shell profile at all is the
  usual cause on macOS — nothing has ever added `~/.local/bin`.
- **"Multiple vaults open"** — run `nexus vaults`, then pass `--vault <name>`.
- **Rejected for missing memory/goal** — every `use` needs `--memory` and
  `--goal`.
- **PowerShell split a legacy command** — move context flags before `--` and
  pass the tool normally after it; do not nest a quoted command string.
- **Multiline content is truncated or split** — pipe it with
  `--<flag>-stdin` or pass its local path with `--<flag>-file` (works for any
  value flag: `--content-stdin`, `--conversation-context-file`, …). Do not
  flatten the content to one line.
- **"Unknown context flag"** — the flag before `--` isn't one of `--memory`,
  `--goal`, `--workspace`, `--session`, `--constraints`, `--vault`, `--json`,
  `--dry-run`. Tool flags (`--path`, `--limit`, …) are only recognized *after*
  the `--` delimiter. camelCase spellings are rejected; use kebab-case.
- **"is a context flag, so it belongs BEFORE the `--` delimiter"** — a
  `--memory`/`--goal`/`--vault`/… ended up inside the tool command. Move it left
  of `--`. `--workspace` is exempt from this check because it is also a real flag
  on `memory load-workspace` — which is exactly why you should pass a tool's
  required value **positionally** (`memory load-workspace "NeuroAI Mapping"`).
  Positional values can never be mistaken for context.
- **"needs an agent AND a tool name"** — the command after `--` lost its agent
  name. It must read `<agent> <tool>`, e.g. `storage list`, never bare `list`.

Flag ordering relative to the verb does not matter: `nexus --vault V use …` and
`nexus use --vault V …` are equivalent. Everything after `--` is passed to the
tool untouched, so context flags there are never consumed as context.
