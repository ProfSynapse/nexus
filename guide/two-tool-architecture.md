# Two-Tool Architecture

Nexus exposes exactly **2 tools** to MCP clients like Claude Desktop:

| Tool | Purpose |
|------|---------|
| `toolManager_getTools` | **Discovery** — Returns schemas for requested agents/tools |
| `toolManager_useTools` | **Execution** — Runs tools with unified context |

---

## Why Two Tools?

Traditional MCP servers expose every operation as a separate tool. With 45+ tools, that means ~15,000 tokens of schema just to describe them — before any actual work happens.

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
3. **Execute** — Call `useTools` with context + a `calls` array of tool invocations

```
getTools → get schemas → useTools with context + calls
```

Multiple tools can be batched in a single `useTools` call.

---

## Full Tool Reference

See [TOOL_REFERENCE.md](../docs/TOOL_REFERENCE.md) for complete parameter schemas for every agent and tool.
