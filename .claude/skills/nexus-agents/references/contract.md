# The two-tool contract

Context: the invariants a change to an agent or tool must not break. Read this
before designing a tool's surface; the enforcement points are named so you can
check them against the tree rather than trusting this file.

## Key idea
MCP exposes two tools. `src/handlers/strategies/ToolListStrategy.ts` returns
`getTools` and `useTools` and nothing else; the server key comes from
`getPrimaryServerKey()` in `src/constants/branding.ts`. Everything else is
internal and reached through those two, so the surface you are adding is a
*command*, not an MCP tool.

## The invariants

### 1. Context is enforced, not merely declared
`useTools` calls `validateExecutionContext` on the normalizer before dispatch
(`src/agents/toolManager/tools/useTools.ts` →
`src/agents/toolManager/services/ToolCliNormalizer.ts`). Empty or placeholder
`memory`/`goal` throws a *recoverable steering error* the model can self-correct
from. Placeholder detection is a real list in the normalizer — `TODO`, `string`,
`example` and friends fail the same as empty.

Discovery is exempt: `getTools` is often the first call, before there is any
conversation to summarize.

The eval harness imports the same functions —
`collectContextContractViolations` and `formatContextContractError` are imported
by `tests/eval/EvalToolExecutor.ts`. One source. Do not fork the rules into a
second copy for a second caller.

### 2. The payload is CLI-first
A top-level `tool` string plus top-level context fields
(`workspaceId`, `sessionId`, `memory`, `goal`, optional `constraints` and the
image/transcription overrides). The older nested shapes are gone with no compat
shim and throw `Deprecated payload shape`:
- a `context` object instead of top-level fields,
- `request` on `getTools`,
- `calls` on `useTools`.

Context fields must not appear as flags inside the `tool` string either; the
normalizer rejects `--memory`, `--goal`, `--session-id` and the rest there.

### 3. Tools receive only their own params
Context validation happens once at the `useTools` layer. `prepareResult` on
`BaseTool` ignores its trailing context arguments — they are deprecated
parameters kept for call-site compatibility. A tool that re-validates context is
duplicating a check that already ran.

### 4. Results are one of two shapes
`{ success: true, ...data }` or `{ success: false, error }`. Build them with
`prepareResult(success, data, error)` rather than by hand.

### 5. The AI never gets a destructive delete
Destructive operations are exposed as `archive`, which is reversible; permanent
delete is UI-only. Check the current spelling per agent with
`grep -rn "slug: 'archive" src/agents/` — the convention is real but the slug
varies (`archive`, `archiveState`, `archiveWorkspace`, `archiveProject`). If you
are adding something that destroys data irreversibly, that is a design decision
to raise, not one to make quietly inside a tool.

### 6. Discovery and executability are separate
Registration makes a tool discoverable. Some tools additionally need a runtime
collaborator wired by the chat UI and fail at call time until it is present —
the subagent tool's `Execution context not available` is the canonical example.
A tool that appears in `getTools` has proven nothing about `useTools`.
