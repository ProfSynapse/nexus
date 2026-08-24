# Protocol: change the payload contract or CLI grammar

Context: you are changing how `useTools`/`getTools` payloads are shaped, parsed
or validated — the context contract, the tokenizer, batching, flag handling, the
verbatim channels. This surface is consumed by MCP clients, native chat, the
terminal CLI and the eval harness at once, and each has its own copy of the
words.

## Mission
Land a contract change that reaches every consumer, breaks loudly rather than
silently for old payloads, and leaves no forked copy of a rule behind.

## Steps
1. Locate the layer you are actually changing before editing:
   - `src/agents/toolManager/services/ToolCliNormalizer.ts` — tokenizing,
     parsing, the context contract, the verbatim `values` channel, deprecated
     shape rejection.
   - `src/agents/toolManager/services/ToolBatchExecutionService.ts` — dispatch
     and per-call context checks.
   - `cli/commandLine.ts` — the terminal CLI's own flag parsing and the
     `--<flag>-stdin` / `--<flag>-file` transports.
2. If the change alters a rule a model is told about, edit the constant in
   `src/agents/toolManager/guidance.ts`. It is the single source for the
   `useTools` tool description, the native-chat system prompt and the eval
   harness. You MUST update the guide mirror in the same change — the drift test
   pins them:
   ```bash
   npx jest tests/unit/cliGuidanceDrift.test.ts
   ```
   Keep those constants plain prose: no markdown backticks, no `${` sequences,
   because each surface embeds them verbatim.
3. Reject removed shapes loudly. The precedent is `Deprecated payload shape`
   thrown for `context`, `request` and `calls` with no compat shim. A silently
   ignored old field is the failure mode to avoid.
4. Do not fork validation for a new caller. The eval harness imports
   `collectContextContractViolations` and `formatContextContractError` directly;
   any new consumer imports them too.
5. Run the contract tests, which encode the current behavior:
   ```bash
   npx jest tests/unit/ToolManagerContextContract.test.ts tests/unit/ToolManagerCliSyntax.test.ts \
            tests/unit/ToolBatchExecutionService.test.ts tests/unit/ToolManagerDynamicRegistry.test.ts
   ```
6. Regenerate the catalog if the change affects how commands or arguments are
   built, since the shipped-docs gate reads it:
   ```bash
   npm run schemas:release
   ```
7. Verify end to end. Run `verify.md`.

## Guidelines
- Pattern: change the rule where it is single-sourced, then let the drift test
  tell you which mirror you forgot.
- Pattern: an error message here is a steering signal, not a log line. Say what
  to do instead — the existing messages name the correct form.
- Anti-pattern: adding a compatibility shim for a shape you just removed. Two
  accepted shapes become two behaviors to keep alive forever.
- Anti-pattern: relaxing the context contract to make a caller pass. The caller
  is what needs fixing; the eval harness deliberately exercises the steering
  path.

## Next
`verify.md`, then `self-refine.md`.
