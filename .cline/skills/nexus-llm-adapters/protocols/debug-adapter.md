# Protocol: debug-adapter

Context: something in chat is wrong — blank output, missing reasoning, a model
that reloads forever, a tool that ran twice. These failures are mostly known, and
their causes sit in specific places. Reading adapter source first is the slow path.

## Mission
Identify the mechanism behind the observed symptom, fix it at that layer, and
prove the fix on all three request paths.

## Steps

1. **State the symptom precisely before touching code.** Which path — streaming or
   not? Which provider family — hosted HTTP, local server, CLI? Did anything reach
   the log? "Blank bubble, nothing logged" and "blank bubble, error toast" are
   different bugs.

2. **Look the symptom up in `references/symptoms.md`.** It maps each known
   symptom to its mechanism and the reference that explains it. Follow the pointer
   before forming your own theory.

3. **For a local server, curl the endpoint directly before blaming the adapter.**
   Local runtimes return undocumented in-stream behaviour that no fixture predicts.
   If curl reproduces it, the fix is not in the adapter. See
   `references/local-providers.md`.

4. **If the symptom is a silent stream, run the wiring check first.** From the repo
   root:

   ```bash
   python3 .claude/skills/nexus-llm-adapters/scripts/check_stream_error_wiring.py \
     --repo-root . <provider-dir>
   ```

   A non-zero exit means the adapter cannot see the provider's error frames, which
   explains a silent stream on its own. Fix that before investigating further.

5. **Fix at the layer the reference names, not the layer where you noticed it.**
   A mismatch between what was stored and what the UI reports is often a layer
   boundary rather than a bug — `references/chat-plumbing.md` covers the two cases
   where that is deliberate. You MUST confirm which it is before "correcting" a
   conversion.

6. **Prove it.** Run `protocols/verify-adapter.md`. A stream fix in particular is
   unproven until the error path has been triggered on purpose.

## Guidelines
- Pattern: reproduce with the smallest provider you can. A local server lets you
  induce error frames on demand; a hosted provider does not.
- Pattern: when the symptom is "nothing happened", suspect a swallowed outcome
  before a wrong one. Silent success is the failure shape this stack produces.
- Anti-pattern: adding defensive code at the UI layer for a stream that produced
  nothing. The stream should have thrown.
- Anti-pattern: deleting a comparison, retry, or fallback that looks redundant.
  Several of them encode a provider behaviour that is not in any documentation;
  `references/local-providers.md` names the ones that must survive refactors.

## Next
`protocols/verify-adapter.md`. Then `protocols/self-refine.md` if the symptom you
hit was not already in `references/symptoms.md`.
