# Local CLI Agent Bridge — Design Plan

**Status:** Design + validated MVP spike (§9 step 1 done; productionizing pending)
**Date:** 2026-07-17
**Author:** design discussion (ProfSynapse + Claude)
**Branch:** `feat/local-cli-agent-bridge`

> **Spike result (2026-07-17):** `cli/nexus-cli.ts` + `cli/mcpLineClient.ts` drive a
> live vault end-to-end with **zero server changes** — `vaults`, `doctor` (MCP
> handshake), `tools <selector>` (getTools), and `use "<cmd>"` (useTools, real files
> returned) all round-trip over the existing socket. Multi-vault resolution and the
> context-contract rejection both behave. Run it: `cli/smoke.sh <vault>`.

## 1. Goal

Let an **external coding agent** — Claude Code, Codex, Cursor, or any shell-driven
agent — reach Nexus's tooling from **normal code / the shell, with no MCP client
configuration**. The agent should be able to:

1. **Discover** the API — `nexus tools [selector]` returns the live tool catalog.
2. **Execute** — `nexus use "<agent action --flags>" --memory … --goal …` runs a tool.

…exactly the two-tool `getTools`/`useTools` protocol Nexus already exposes over MCP,
but presented as a **shell-native CLI** the agent calls via Bash. No Claude Desktop
config entry, no server registration, no new network surface.

Non-goals are listed in §12.

## 2. Mental model (the important part)

> **The CLI is a second client on the socket `connector.js` already uses.**

Three facts about the current architecture make this small:

1. **`connector.js` is a dumb pipe.** It is literally `stdin.pipe(socket);
   socket.pipe(stdout)` (`connector.ts`). All MCP framing happens at the two *ends*
   (Claude Desktop and the plugin's SDK server), not in the connector.
2. **The socket is multi-client.** `IPCTransportManager` spins a per-connection
   `MCPSDKServer` instance, so a new client can connect *while* Claude Desktop is also
   connected.
3. **`getTools`/`useTools` are already the CLI-first protocol.** Behind them sits
   `ToolCliNormalizer` → `ToolBatchExecutionService`, and the command string
   (`content read --path X`) is the *native* input shape the normalizer parses.

So the CLI is a ~250-line socket client: connect to
`/tmp/nexus_mcp_<vault>.sock` → minimal MCP handshake → one `tools/call` for
`getTools` or `useTools` → print JSON → exit. **The server side does not change.**

```
Today:
  Claude Desktop ──stdio MCP──▶ connector.js (dumb pipe) ──unix socket──▶ Nexus plugin ──▶ agents

Added (no server change):
  Claude Code / Codex ──Bash──▶ nexus CLI ──unix socket──▶ Nexus plugin ──▶ agents
                                (2nd concurrent client on the same socket)
```

### What is genuinely new code

Only the **MCP client handshake**. Today Claude Desktop implements the client side of
MCP; the CLI is the first thing Nexus ships that must *send* `initialize` +
`notifications/initialized` and read `\n`-framed JSON-RPC responses itself. This is the
one place to spend care and a test. Everything else (discovery, execution, validation,
context contract) is reuse.

## 3. Two scoping axes (resolving the "global vs per-vault" question)

Two questions that were easy to conflate, with **different** answers:

| Question | Answer | Why |
|---|---|---|
| **Where is the tool installed / discovered?** | **Machine-global** | The binary is a vault-agnostic socket client; the skill is generic text. Per-vault copies are the same file N times. |
| **Which vault does a call operate on?** | **Per-vault, resolved at runtime** | Each open vault exposes its own socket; the vault is selected at call time, not by where files live. |

Consequence: install once per machine; choose the vault per invocation (§5). **Nothing
is written into the synced `Nexus/` vault-data root** — an earlier idea, dropped: the
binary is machine-global, so syncing it saves zero clicks (a symlink must be created per
machine regardless) while adding version-skew reconcile complexity. See §11 for the
history of this decision.

## 4. Discovery model — progressive disclosure (the token budget)

The agent finds Nexus through a **skill** (Claude Code) or an **AGENTS.md pointer**
(Codex). The design goal is *minimal always-on token cost*:

| Layer | Loaded when | Cost |
|---|---|---|
| Skill `name` + `description` (frontmatter) | **Always**, every session | ~15 tokens |
| `SKILL.md` body (loop + contract + 1 example) | When the agent judges it relevant | ~200 tokens |
| `nexus tools <selector>` (live catalog slice) | Only when about to act | selector-scoped |

The API surface **never lives in a file** — it is fetched live via `nexus tools`, and
selector-scoped (`nexus tools search` returns just the search agent, not all 55;
`getTools` already has the compact-discovery cap ~3k). The `SKILL.md` body stays ~20
lines: the discover→use loop, the "always pass `--memory`/`--goal`" contract line, one
worked example, and the multi-vault recovery line. **The description line is the entire
always-on token budget** — it must be tight and trigger-rich.

Codex has no skill system → it reads `AGENTS.md`; for Codex the installer writes/updates
a pointer block in its global instructions instead of a skill folder.

## 5. Vault resolution (how the CLI knows which vault)

The vault name is embedded in the socket filename
(`/tmp/nexus_mcp_<sanitizedVaultName>.sock`, named pipe on Windows). Globbing that is the
source of truth for "which vaults are reachable right now" — **no registry, no synced
file, no mapping table.**

Resolution precedence at call time:

```
1. --vault <name>     explicit flag → sanitizeVaultName() → match a live socket
2. NEXUS_VAULT env    same resolution; lets a shell / repo pin a vault with no file
3. defaultVault       one optional value in machine-global config (set by installer)
4. exactly one live   → use it (common case: zero config)
5. multiple live      → error listing them + "pass --vault <name>"
6. named but not live → "vault 'Work' is not currently open in Obsidian"
```

Key trick: the CLI embeds the **same `sanitizeVaultName()`** the connector uses (shared
module, §7). So the agent passes the *human* vault name and the CLI sanitizes it to match
the socket — `--vault "My Notes"` → `my_notes` → `/tmp/nexus_mcp_my_notes.sock`. No
display-name mapping to maintain.

Agent learns valid names two ways, both self-serve:
- **`nexus vaults`** — lists live sockets, marks the default.
- The **multi-vault error** lists the open vaults, so the agent recovers even without the
  skill. Single-vault users hit case 4 forever and never see this.

The only persisted state on the whole machine is the optional `defaultVault` value.

## 6. Install model (one gated click; safe; reversible)

True zero-touch is **not** an option under Obsidian + safety policy: a plugin silently
symlinking into `~/.local/bin` and `~/.claude/` on load is the "modifies the user's
system without consent" pattern that fails review. The honest target is **one gated
click, once, that survives updates** — mirroring the precedent the connector setup
already set (explicit, one-click, labeled, reversible, writes out-of-vault only on user
action).

The installer (`enableForLocalAgents()`), triggered from a Getting Started section:

1. **Generate** `nexus-cli.js` into a machine-global location (`~/.local/share/nexus/`
   or equivalent) from embedded `NEXUS_CLI_CONTENT`.
2. **Symlink** `~/.local/bin/nexus` → that file (PATH), so the skill reads clean.
3. **Per detected agent**, install the discovery artifact into its **global** config dir:
   - Claude Code → symlink/copy `~/.claude/skills/nexus/` → the skill folder.
   - Codex → append a pointer block to its global `AGENTS.md`-style instructions.
   - (Cursor / others → their convention, as supported.)
4. **Disclose** exactly what it will create before doing it, and write nothing for an
   agent whose global dir does not already exist (**detect, don't assume** — presence of
   `~/.claude` ⇒ Claude Code installed).

`uninstall()` removes every symlink/file it created — never leaves orphan system state.

**Scope discipline:** auto-install targets **global** agent dirs only. It never scatters
into per-project `<repo>/.claude/` folders (the plugin cannot know the user's repos, and
writing into arbitrary repos is invasive + a policy red flag). A separate **"Add to a
project folder…"** picker handles per-repo scoping on demand. Per-repo *vault pinning*
without any file is `NEXUS_VAULT` (§5).

### Content freshness across plugin updates

The machine-global files are **refreshed from embedded content on plugin load**
(upgrade-only, hash-guarded so unchanged content is not rewritten). Because they live
outside the plugin folder they survive plugin update/reinstall; because they are not
synced there is no cross-machine version-skew problem. This replaces the synced-folder
reconciler that an earlier iteration required.

## 7. Files

### New — the CLI
- **`cli/nexus-cli.ts`** — the standalone CLI. argv parsing (`tools` / `use` / `vaults`
  / `doctor` / `--help`), vault resolution (§5), builds the CLI-first payload, prints
  JSON, exit codes. Compiled to `nexus-cli.js` (CommonJS), mirroring the connector build.
- **`cli/mcpLineClient.ts`** — minimal MCP-over-socket client: connect → `initialize` →
  `notifications/initialized` → `tools/call` → match response id → timeout/error
  handling; `\n`-delimited JSON framing. The only genuinely new protocol code; split out
  so it is unit-testable.

### New — shared socket-path logic (kills drift)
- **`src/utils/ipcSocketPath.ts`** — extract `sanitizeVaultName()` + `getIPCPath()`
  (currently duplicated inside `connectorContent`) so `connector.ts` **and**
  `cli/nexus-cli.ts` import one source. Add `listVaultSockets()` (glob
  `/tmp/nexus_mcp_*.sock` → sanitized names). Refactor `connector.ts` to use it.

### New — codegen + embedded content (mirror connector)
- **`scripts/generate-cli-content.mjs`** — copy of `generate-connector-content.mjs`;
  reads compiled `nexus-cli.js`, emits `src/utils/cliContent.ts` as `NEXUS_CLI_CONTENT`.
- **`src/utils/cliContent.ts`** — generated, do-not-edit (like `connectorContent.ts`).

### New — discovery artifacts
- **`skill/SKILL.md`** — the tight skill (frontmatter description = the always-on token
  budget; body ~20 lines). Source of truth; the installer symlinks/copies it into
  `~/.claude/skills/nexus/`.
- **`src/utils/agentInstructionsContent.ts`** — the `AGENTS.md` pointer block string for
  Codex / skill-less agents (copyable + writable).

### New — install service
- **`src/services/cli/LocalCliInstaller.ts`** — `enableForLocalAgents()`,
  `uninstall()`, per-agent adapters, agent detection, disclosure text, on-load refresh
  (`reconcileMachineGlobalAssets()`, upgrade-only + hash-guarded). Desktop-guarded via
  `desktopRequire`.

### Edit — build wiring
- **`package.json` `build`** — after the connector chain, add:
  `tsc cli/nexus-cli.ts cli/mcpLineClient.ts --outDir . --esModuleInterop true --module
  commonjs --skipLibCheck && node scripts/generate-cli-content.mjs`.

### Edit — path helpers
- **`src/utils/cliPathUtils.ts`** — add machine-global path helpers
  (`getNexusCliInstallPath()`, `getNexusBinSymlinkPath()`) + agent-dir resolvers
  (`~/.claude/skills`, Codex instructions).

### Edit — settings UI
- **`src/settings/tabs/GetStartedTab.ts`** — new "Local CLI (no MCP)" subsection under
  `renderGenericAgentsSection`: status line (on PATH? socket reachable? detected agents),
  **Enable for local agents** (calls the installer, discloses paths), **Add to a project
  folder…** (picker), **Uninstall**. Mirrors the existing connector buttons.

### New — docs + tests
- **`docs/nexus-cli.md`** — protocol, command grammar, the context contract, vault
  resolution, troubleshooting ("is Obsidian open?").
- **`cli/__tests__/nexus-cli.test.ts`** — pure unit: argv → payload shaping
  (`nexus use "content read --path X" --memory a --goal b` → correct `useTools` call);
  vault resolution precedence. Optional integration: fake socket speaking MCP, full
  round-trip.

### Not changed
- **Server side** — `IPCTransportManager`, `MCPServer`, agents: **no edits** (riding
  MCP-JSON-RPC over the existing socket). Only the plain-JSON-channel variant (§10) would
  touch `IPCTransportManager`.

## 8. Security & Obsidian policy

- **No action on install/load.** Setup runs only from an explicit settings button, never
  at `onload`. (On-load only *refreshes* already-installed files, never creates new
  out-of-vault state.)
- **Consent + transparency.** The button names the exact paths it will create
  (`~/.local/bin/nexus`, `~/.claude/skills/nexus`) before acting.
- **Reversible.** `uninstall()` removes everything; the UI can always clean it.
- **Detect, don't assume.** Only writes where an agent's global dir already exists.
- **Desktop-guarded.** `fs`/`os`/symlink via `desktopRequire`, gated on
  `Platform.isDesktop` (the standard pattern).
- **Trust boundary is unchanged — and say so.** The CLI can run any tool (incl.
  writes/deletes), but anything that can already reach the socket could do the same; the
  socket is filesystem-permissioned to the user, exactly as the connector is today. The
  PATH binary widens *ergonomics*, not *exposure*. Document plainly.
- **Context contract still enforced server-side.** A `nexus use` omitting `--memory`/
  `--goal` gets the real steering rejection from `ToolCliNormalizer.validateExecutionContext`
  — same guidance any agent would get. A feature; document so it is not a surprise.
- **Windows.** Symlinks need dev-mode/elevation → fall back to a copied launcher `.cmd`
  shim + copied skill (accept drift only on Windows, refreshed on load).

## 9. Build order

1. **MVP spike (no plumbing).** `cli/nexus-cli.ts` + `cli/mcpLineClient.ts` only. Run
   `node nexus-cli.js vaults|tools|use …` against a live vault. Proves the handshake +
   round-trip end-to-end and is *already usable* by Claude Code via absolute path. One
   evening. This de-risks the only genuinely new code (§2).
2. **Productionize.** Shared `ipcSocketPath` module → codegen → build wiring →
   `LocalCliInstaller` → settings section → machine-global install + symlinks + on-load
   refresh.
3. **Discoverability.** `SKILL.md` + `agentInstructionsContent` + per-agent adapters +
   `docs/nexus-cli.md`.

## 10. Open questions / verify before/around build

**RESOLVED by the spike + guide-agent check (2026-07-17):**
- ✅ **Claude Code skill discovery** — global path is `~/.claude/skills/<name>/SKILL.md`,
  and Claude Code **follows symlinks** there (loads once even if reachable from multiple
  locations). Frontmatter all optional; `description` (+ `when_to_use`) capped at **1536
  chars combined**. Project-level is `<repo>/.claude/skills/`. The symlink install design
  holds. Source: code.claude.com/docs/en/skills.md.
- ✅ **Codex global-instructions path** — `~/.codex/AGENTS.md` (project: `AGENTS.md`
  walked repo-root→cwd). Codex skill-dir paths are not authoritatively documented → use
  the `AGENTS.md` pointer block for Codex.
- ✅ **MCP framing** — newline-delimited JSON-RPC confirmed working against the live SDK
  server (`@modelcontextprotocol/sdk` 1.29.0; sent `protocolVersion: 2025-06-18`).
- ✅ **Exposed tool names** — `toolManager_getTools` / `toolManager_useTools` (underscore,
  not dotted). `useTools` args are top-level `{workspaceId, sessionId, memory, goal, tool}`.
- ⚠️ **getTools is NOT param-exempt** — despite the "discovery exempt" note (which is about
  the *useTools steering error*), `getTools` validates `memory`/`goal` at the param layer
  too. The CLI auto-fills sensible defaults for `nexus tools` so callers need not pass them.

**Still to verify when productionizing:**
- **Short-lived connection cleanup:** the spike connects/calls/disconnects fine, but verify
  the per-connection `MCPSDKServer` (multi-client path in `IPCTransportManager`) does not
  leak across many rapid CLI invocations.
- **Wire-protocol choice (the one real fork):** keep **MCP-JSON-RPC under the hood**
  (reuse the SDK server as-is, CLI does the handshake — zero server change) vs. a **plain
  line-JSON op channel** in `IPCTransportManager` (trivial CLI, but forks the transport
  and adds maintenance). Recommendation: ship MCP-under-the-hood; add the plain channel
  only if the handshake actually annoys in practice.

## 11. Decisions log (why the design moved)

- **Out-of-process, not in-process.** The consumer is an external agent (Claude Code /
  Codex), so the surface is a CLI over the existing socket, not a plugin-instance API.
- **Reuse the IPC socket, not a new HTTP server.** No new TCP port (plugin-store /
  security concern avoided); the socket is already multi-client and filesystem-permissioned.
- **Skill over AGENTS.md as the primary surface.** Progressive disclosure makes the
  always-on cost ~15 tokens; AGENTS.md is the fallback for skill-less agents.
- **Machine-global install, not synced `Nexus/`.** The binary/skill are vault-agnostic;
  a per-machine symlink is required regardless, so syncing the files saves no clicks while
  adding version-skew reconcile + "which vault owns the symlink" fragility. Dropped the
  `Nexus/cli/` artifact and its reconciler entirely.
- **Vault chosen at runtime from live sockets.** Socket glob + shared `sanitizeVaultName`
  replaces any registry/mapping; the only persisted state is an optional `defaultVault`.

## 12. Out of scope (v1)

- Headless operation without Obsidian running — the CLI bridges to a **live** process; it
  cannot operate a vault with Obsidian closed (same constraint as MCP today).
- Mobile — unix socket / node `net`; external coding agents are desktop anyway.
- Auto-installing into per-project repos — global dirs only; per-repo is opt-in via the
  picker / `NEXUS_VAULT`.
- Token/bearer auth on the socket — filesystem permissions are the current (and adequate,
  single-user) boundary; add later if a multi-user threat model appears.
- The plain-JSON transport channel (§10) — deferred unless the MCP handshake proves
  annoying.

## 13. Risks / guardrails

- **Handshake correctness is the main risk.** Isolate it in `mcpLineClient` with a test;
  de-risk in the MVP spike before any plumbing.
- **Wrong-vault writes.** Never guess when multiple sockets are live — error and list
  (case 5, §5). Writing to the wrong vault is a real harm; ambiguity must fail closed.
- **Symlink target in a live-syncing folder** — N/A now that files are machine-global and
  unsynced (a benefit of the §3 decision).
- **Drift between embedded CLI and shared socket-path logic** — mitigated by the shared
  `ipcSocketPath` module + regenerate-on-build (same discipline as the connector).
- **Steer, never surprise.** The context-contract rejection is guidance, not a silent
  failure; document it in the skill and `docs/nexus-cli.md`.
