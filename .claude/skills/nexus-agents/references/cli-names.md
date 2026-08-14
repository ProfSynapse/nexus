# Slugs, CLI names and the parsing rules that follow

Context: what a caller types is not what you wrote in source. Read this while
choosing a slug or a parameter name, and whenever a documented command does not
resolve. Everything here lives in
`src/agents/toolManager/services/ToolCliNormalizer.ts`; the model-facing prose
version is single-sourced in `src/agents/toolManager/guidance.ts`.

## Key idea
A command is `<agent alias> <tool name>`, and both halves go through
`toKebabCase`, which **strips a trailing `Manager`, `Agent` or `Tools`** before
kebab-casing. There is no alias table — `getAgentAlias` is just
`toKebabCase(agentName)`.

That is why `searchManager` is typed `search`, `webTools` is `web`, and the
`subagent` slug on `promptManager` advertises as **`prompt sub`**. Writing
`prompt subagent` in a doc sends the caller to a command that does not resolve.

Do not apply the transform in your head:

```bash
python3 .claude/skills/nexus-agents/scripts/cli_name.py subagent --agent promptManager
nexus tools "prompt sub"       # resolves — "prompt subagent" does not exist
```

That script reads the suffix list out of the live `toKebabCase` body, so it
cannot drift from source the way a memorized rule does.

## Parameter names become flags, and `required` reshapes the command
`getParameterSchema()` is compiled into a CLI schema by `buildCliSchema`:

- Every property becomes `--<kebab-cased-name>`, so `notePath` is `--note-path`.
- A property that is `required` **and** not boolean, object or array becomes a
  **positional** argument, in property order. Marking a field required therefore
  changes the shape of every call site — `content read --path x.md` versus
  `content read x.md`.
- Common context params are stripped from the CLI schema by `stripCommonParams`,
  so do not redeclare `workspaceId`, `sessionId`, `memory`, `goal`, `context` or
  `workspaceContext` in a tool's own schema.

## Schemas are documentation, not validation
There is no ajv behind execution. At runtime `required`, `oneOf` and `enum`
reject nothing on their own. The one place `required` has teeth is a command
typed as a `tool` string, where the normalizer raises
`Missing required argument "<name>"` for an absent slot — it still never checks a
value's type, shape or `enum` membership.

Guards belong in the tool's `execute()` or the service beneath it. The repo ships
helpers for exactly this: `ToolParamValidator` in
`src/agents/validation/ToolParamValidator.ts`
(`requireString`, `optionalString`, `requireArray`, `requireObject`) throws a
descriptive `Error` you catch and turn into `prepareResult(false, undefined,
message)`. The class comment records the bug that motivated it: a `linkedNotes`
entry missing `notePath` persisted `notePath: undefined` until
`normalizeLinkedNote` in `src/agents/taskManager/services/TaskService.ts` guarded
it.

## Batching: when a comma splits a command
A top-level comma outside quotes separates batched commands **only when followed
by whitespace or end of input**. So `--paths a,b,c` stays one CSV value, and
`--paths a, b` becomes two commands. This is deliberate (issue #181) and the
per-item CSV split happens later at coercion time.

## Getting content through intact
Two lossless channels exist because a model composing the `tool` string escapes
content twice — once for JSON, once for the CLI quoting contract — and
backslash-heavy content is silently corrupted in between.

**Through MCP or chat**: the optional top-level `values` map, referenced from the
tool string as `@key` as its own **unquoted** token. Substitution happens after
tokenization with no escape processing, so backslashes and newlines survive.
Quoting the token (`"@key"`) deliberately passes the literal text instead. Every
declared key must be referenced somewhere or the call throws — an unreferenced
value is silent data loss.

**Through the terminal CLI**: `--<flag>-stdin` and `--<flag>-file <path>` work
for any tool flag. At most one `-stdin` per command (standard input is read
once); several `-file` transports may coexist; a flag must never arrive both
directly and through a transport.

Inline multiline is supported and does not need either channel: quote the value
and escape embedded double quotes. Flattening multiline content to one line is
never the fix.
