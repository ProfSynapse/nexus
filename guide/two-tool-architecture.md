# Two-Tool Architecture

Nexus exposes exactly **2 tools** to MCP clients like Claude Desktop:

| Tool | Purpose |
|------|---------|
| `toolManager_getTools` | **Discovery** — Returns schemas for requested agents/tools |
| `toolManager_useTools` | **Execution** — Runs tools with unified context |

---

## Why Two Tools?

Traditional MCP servers expose every operation as a separate tool. With 60+ tools, that means ~15,000 tokens of schema just to describe them — before any actual work happens.

Nexus collapses that to **~500 tokens** upfront. The AI discovers tool schemas on demand via `getTools`, then calls them through `useTools`.

**Benefits:**
- **~95% token reduction** in upfront schema cost
- Works well with small context window models (local LLMs, Ollama)
- Context-first design captures memory and goals for every operation

---

## Context Schema

Every `useTools` call includes context that maintains continuity across operations:

```typescript
{
  workspaceId: string;   // Scope identifier (name or UUID)
  sessionId: string;     // Session name (system assigns standard ID)
  memory: string;        // Conversation essence (1-3 sentences)
  goal: string;          // Current objective (1-3 sentences)
  constraints?: string;  // Rules/limits (1-3 sentences, optional)
}
```

This context is passed to every tool execution, so agents always know the current workspace, session, and intent.

---

## Typical Flow

1. **Discover** — Call `getTools` with the agents/tools you need
2. **Receive schemas** — Get parameter schemas for just those tools
3. **Execute** — Call `useTools` with the context fields at the top level plus a
   single `tool` string holding one or more CLI commands

```
getTools → get schemas → useTools with context + tool string
```

```json
{
  "workspaceId": "research",
  "sessionId": "session-name",
  "memory": "brief summary of the conversation so far",
  "goal": "brief statement of the current objective",
  "tool": "storage move --path notes/a.md --new-path archive/a.md, content read --path archive/a.md"
}
```

Multiple commands can be batched in one `useTools` call by separating them with a
top-level comma outside quotes; commas inside a quoted value stay literal.

> The context fields go at the **top level**, never inside a nested `context`
> object, and never as CLI flags inside the `tool` string. The older
> `calls: [{ agent, tool, params }]` array was removed in v5.9.0 and is now
> rejected outright.

---

## Full Tool Reference

There is no static tool reference to go stale — the authoritative, per-vault
catalog is always live:

- **From an MCP client:** call `getTools` with a selector — `"--help"` for the
  agent catalog, `"storage"` for one agent, `"storage list"` for a single tool's
  full argument schema.
- **From the shell:** `nexus tools`, `nexus tools storage`, `nexus tools "storage list"`
  (see [nexus-cli.md](nexus-cli.md)).
