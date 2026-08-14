# Protocol: add a tool to an existing agent

Context: you are adding a command to an agent that already exists and is already
registered. The agent's own wiring is out of scope here — see `add-agent.md` for
that.

## Mission
Ship a tool that is discoverable through `getTools`, executable through
`useTools` under the name a caller will actually type, and safe against the
malformed arguments its schema will not reject.

## Steps
1. Read how the agent's existing tools are declared, so the new one matches:
   ```bash
   grep -n "slug:" src/agents/<agent>/<agent>.ts
   ls src/agents/<agent>/tools/
   ```
2. Choose the slug, then check what it becomes on the command line **before**
   writing it into source. The transform strips a trailing
   `Manager`/`Agent`/`Tools`:
   ```bash
   python3 .claude/skills/nexus-agents/scripts/cli_name.py <yourSlug> --agent <agentName>
   ```
   If the result is not what you intended, change the slug now. See
   `../references/cli-names.md`.
3. Create `src/agents/<agent>/tools/<toolName>.ts` extending
   `BaseTool<Params, Result>`. The constructor takes `(slug, name, description,
   version)`. `execute()` and `getParameterSchema()` are abstract;
   `getResultSchema()` already returns the common result schema, so override it
   only when that is wrong.
4. Write the parameter schema knowing it is compiled into a CLI surface. Marking
   a non-boolean, non-object, non-array field `required` makes it **positional**
   and changes every call site; property names kebab-case into flags; common
   context params are stripped, so do not redeclare them.
5. Guard the arguments in `execute()`. The schema validates nothing at runtime,
   so you MUST check every field you will persist, pass to the filesystem, or
   hand to another service. Use `ToolParamValidator` from
   `src/agents/validation/ToolParamValidator.ts` inside a top-level try/catch and
   return `prepareResult(false, undefined, error.message)` on throw.
6. Return results through `prepareResult(success, data, error)` so the shape
   stays `{ success: true, ...data }` / `{ success: false, error }`.
7. Register it in the agent constructor. `registerLazyTool({ slug, name,
   description, version, factory })` is the norm — metadata is available
   immediately and construction is deferred to first use. Use eager
   `registerTool(new X())` only when construction needs dependencies the factory
   closure cannot reach.
8. If the tool must exist only under some condition (a credential, a platform,
   a service), register it conditionally here rather than registering a tool
   that always fails. See `../references/registration.md`.
9. Optionally override `getStatusLabel(params, tense)` for the tool status bar.
   Keep it a pure, cheap function of its arguments — it runs in the UI event
   loop.
10. Verify. Run `verify.md`; a green build proves neither discovery nor
    execution.

## Guidelines
- Pattern: decide the slug against the transform, not against the file name. The
  cheapest moment to fix a surprising command name is before it is written down
  anywhere.
- Pattern: if the tool destroys something, expose it as `archive` and raise the
  design question — the AI surface has no irreversible delete.
- Anti-pattern: putting validation in the schema and calling it done. Nothing
  reads it at runtime.
- Anti-pattern: a tool that registers everywhere and returns "unavailable" in
  half of them. Absent beats useless; it saves a discovery round-trip.

## Next
`verify.md`. Do not report the tool as added before it exits clean.
