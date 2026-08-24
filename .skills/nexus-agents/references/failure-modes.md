# Failure modes

Context: keyed by the symptom you are actually looking at. Each entry names the
cause, the fix, and a command that proves which one you have. Every one of these
has bitten someone in this repo.

## "My documented command returns nothing / unknown tool"
The CLI name is not the slug. `toKebabCase` strips a trailing
`Manager`/`Agent`/`Tools`, so a slug ending in `Agent` advertises without it
(`subagent` → `prompt sub`).

Prove it against the catalog, not the source:
```bash
node scripts/generate-tool-schemas.mjs --output - --selector "prompt" | grep '"command"'
python3 .claude/skills/nexus-agents/scripts/cli_name.py <yourSlug> --agent <agentName>
```
Detail: `cli-names.md`.

## "Malformed params reached my service and persisted garbage"
`getParameterSchema()` is documentation plus CLI-normalizer hints. Nothing
validates values at runtime — `required`, `oneOf` and `enum` reject nothing.
Guard in `execute()` with `ToolParamValidator`, or in the service beneath it.
Detail: `cli-names.md`.

## "My comma-separated argument got split into two commands"
A top-level comma outside quotes separates commands, but only when followed by
whitespace or end of input. `--paths a,b,c` is one value; `--paths a, b` is two
commands. Detail: `cli-names.md`.

## "Deprecated payload shape"
Something is still sending `calls`, `request`, or a nested `context` object.
Context fields go at the top level of the payload — and must not appear as CLI
flags inside the `tool` string either. Detail: `contract.md`.

## "My multiline content arrived flattened or mangled"
Escaping stacked twice (JSON, then the CLI quoting contract). Use the `values`
map with an unquoted `@key`, or `--<flag>-stdin` / `--<flag>-file` on the
terminal CLI. Do not flatten. Detail: `cli-names.md`.

## "I passed a capability flag and the agent registered anyway"
`enableSearchModes` and `enableLLMModes` are not a gating pattern to copy — the
search flag lands on an ignored legacy parameter, and PromptManager registers
either way behind a fallback provider manager. Gate by returning early from the
initializer, by conditional per-tool registration, or by the app-agent patterns.
Detail: `registration.md`.

## "My tool is discoverable but returns 'Execution context not available'"
Registration and executability are separate. Some tools need a runtime
collaborator wired by the chat UI — the subagent tool gets its executor through
`setSubagentExecutor`, and answers with that error until it does. Detail:
`contract.md`.

## "I edited cliAssets.ts and my change vanished"
It is generated during the build by `scripts/generate-cli-content.mjs`, which
embeds the built CLI bundle plus the agent-discovery assets. Its own header says
not to hand-edit it. Edit the sources it reads instead:
```bash
grep -n "read(" scripts/generate-cli-content.mjs   # the exact inputs, current
```

## "My one-off schema export did not fix the shipped-docs test failure"
The direct generator writes only the selected output, while the release command
refreshes every committed catalog alias that shipped guidance validates:
```bash
npm run schemas:release
```

## "A doc named a tool that does not exist and nothing caught it"
That gate reads a fixed set of shipped guidance files — README, the CLI entry
point, the packaged skill and its playbooks, and the guide directory. Confirm the
current list yourself:
```bash
grep -n "explicit\|listMarkdown" tests/unit/shippedGuidanceCommands.test.ts
```
It does **not** read `.claude/skills/**`. Anything written in a skill file is
unguarded, which is why this skill gives commands instead of tables — and why
`scripts/check_documented_commands.py` exists.

## "My new dynamic registrar broke getTools discovery"
The `syncToolManagerAgent` bridge keeps discovery in sync for `AppManager` only.
It does not compose for a second registrar. Detail: `registration.md`.

## "I changed a CLI rule and the guide test now fails"
The model-facing wording of the CLI contract is single-sourced in
`src/agents/toolManager/guidance.ts` and mirrored verbatim into the native-chat
system prompt guide, pinned by `tests/unit/cliGuidanceDrift.test.ts`. Update the
constant and its mirror together. Detail: `../protocols/change-payload-contract.md`.
