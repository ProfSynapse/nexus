# Protocol: add-model

Context: a provider already has a registry under
`src/services/llm/adapters/<provider>/`, and a model needs to be added to it or
an existing entry corrected. The compiler will accept any well-typed literal, so
every failure mode here is a wrong value rather than a broken one.

## Mission
A registry entry whose every field is sourced from the provider, structurally
checked, and proven against the live endpoint.

## Steps

1. **Source the facts from the provider, not from memory or another registry.**
   You need the provider-facing model id, a display name, context window, max
   output tokens, input and output price per million tokens, and which of the
   five capability flags hold. `references/registry-anatomy.md` says what each
   one means and how the value is used.

   - The same model has a *different id and a different price* through each
     gateway. Never copy an entry from one provider's registry into another's.
   - For Anthropic models, load the `claude-api` skill rather than answering from
     memory — it is the maintained reference for ids and pricing.
   - For gateway providers, the gateway's own public model listing is the
     authority on the namespaced id. `nexus-model-eval` documents a keyless
     lookup for the one Nexus uses most; reuse it rather than guessing whether a
     slug resolves.
   - A model id you cannot find in a provider-published listing is a model id you
     are about to invent. Stop and ask.

2. **Locate the registry and read a neighbouring entry.**

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . --list
   ```

   The row names the file, its entry count and its current default. Read one
   existing entry in that file before writing yours: a provider's registry
   carries local conventions (namespacing, zero pricing, variant pairs) that the
   type does not express.

3. **Write the entry.** Fill every field, including all five capability flags —
   an omitted flag is read as unsupported and silently removes a UI affordance.
   `references/registry-anatomy.md` has the per-field rules. Do not guess a
   capability: if you cannot confirm the model supports tool calls or reasoning
   from the provider's own documentation, that is a fact still to be gathered,
   not a coin flip.

4. **Decide whether this model becomes the provider default.** If it does, stop
   here and work `change-default.md` before continuing — the default lives in
   several files and editing only the registry export leaves the app on the old
   model.

5. **Check whether the id needs routing, not just metadata.** Some models are
   dispatched away from the ordinary chat path by matching on substrings of the
   model id, and a new id that ought to match but does not will be sent down the
   wrong path with no error. The clearest case is the deep-research handler in
   the OpenAI adapter directory: read its id-matching predicate and decide
   whether your new id belongs in it. Treat that as the general question — grep
   the provider's adapter for comparisons against model ids:

   ```bash
   rg -n "model\.(includes|startsWith)|modelId\.(includes|startsWith)" \
     src/services/llm/adapters/<provider>
   ```

6. **Update the CLI twin registry — or the API one, coming the other way.**
   Two vendors have *paired* registries that cover the same models through
   different transports and drift independently:

   | API registry | CLI-backed twin | Twin verification |
   |---|---|---|
   | `anthropic/AnthropicModels.ts` | `anthropic-claude-code/AnthropicClaudeCodeModels.ts` | `printf '...' \| claude -p --model <id>` |
   | `openai/OpenAIModels.ts` | `openai-codex/OpenAICodexModels.ts` | `codex exec --model <id> ...` |

   When you touch either side of a pair, open the other side and decide,
   per model, whether it belongs there too. The twin's conventions differ:
   cost is 0 (subscription-billed), and availability must be proven through
   the *CLI*, not the API — the anti-pattern below still applies, so verify
   with the twin's own command. Skipping this step is how the Claude 5
   family sat in the API registry for weeks while the Claude Code provider
   still topped out at Sonnet 4.6 (fixed 2026-08-27).

7. **Run the structural gate.**

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . <provider>
   ```

   A non-zero exit is a stop. Fix what it prints and re-run. Warnings on
   providers you did not touch are pre-existing findings, not your regression —
   read them, do not silence them.

8. **Verify.** Go to `verify-model.md`. An entry that has never produced a
   response from the provider is an assertion, not a model.

## Guidelines
- Pattern: add one model at a time and verify it. A batch of six entries fails as
  one opaque unit and every id is then suspect.
- Pattern: when a provider publishes a family, add only the members someone will
  select. Every entry is a row in a picker and a claim you have to keep true.
- Anti-pattern: inferring pricing from a sibling model in the same family.
  Pricing tiers do not follow naming.
- Anti-pattern: adding a model to a subscription-backed or CLI-backed provider
  because it exists in that vendor's public API. Availability through an OAuth or
  CLI endpoint is a separate fact and has to be confirmed separately.

## Next
`verify-model.md`. If this model became the default, `change-default.md` comes
first.
