# Protocol: change-default

Context: a provider's default model is moving. The registry export is the
obvious place and the least effectual one — several other files carry the same
value independently, TypeScript compares none of them, and whichever the runtime
reads last is the one users get.

## Mission
Every declaration of this provider's default naming the same model, with the
tests that pinned the old one updated deliberately.

## Steps

1. **Record the outgoing id before you change anything.** You will grep for it,
   and once it is overwritten in the registry you have lost the search term.

   ```bash
   OLD=$(python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . --list |
     awk '$1=="<provider>"{sub(/^default=/,"",$4); print $4}')
   echo "$OLD"
   ```

2. **Confirm the incoming model is already in the registry.** A default that
   names an id no entry declares resolves to nothing. If it is not there yet,
   work `add-model.md` first.

3. **Change the registry export.** `<PROVIDER>_DEFAULT_MODEL` in that provider's
   `*Models.ts`. This is the value the central `DEFAULT_MODELS` map re-exports
   and the live smoke lane resolves when no model is given.

4. **Check the adapter constructor.** Some adapters pass the registry export into
   `super(...)`; others hard-code the same string as a literal. Where it is a
   literal, the adapter wins at runtime and the registry export becomes
   decorative. The durable fix is to import the export and pass it, which removes
   the second source of truth permanently. The gate in step 7 catches the drift
   either way.

5. **Check the shipped settings default.** A fresh install starts on a
   provider/model pair declared in the settings defaults under `src/types/`,
   independently of any registry. It is not covered by the type system and has
   drifted before. Find it with:

   ```bash
   rg -n "defaultModel:\s*\{" src/types
   ```

   Change it only if this provider is the one a fresh install starts on.

6. **Find every remaining mention of the old id.**

   ```bash
   rg -n --fixed-strings "$OLD" src tests docs
   ```

   Expect hits in the unit tests: some assert a provider's default id literally,
   and some assert the model a request body carries. Those assertions are the
   point — update them to the new id rather than loosening them, so the next
   silent drift still fails a test.

7. **Run the gate in strict mode.** A default change is exactly the case where
   the warnings matter, so do not run the default mode here.

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root . --strict <provider>
   ```

8. **Verify.** Go to `verify-model.md`. Run the live smoke lane for this provider
   with no model override, so it resolves the new default the way the app does.

## Guidelines
- Pattern: promote a default only after the model has passed tool-use grading.
  Text coming back is not evidence it can drive the two-tool protocol, and the
  default is what most users will run. `nexus-model-eval` owns that grading.
- Pattern: when you find a literal that duplicates the registry export, replace
  it with the import. One less place for the next person to miss.
- Anti-pattern: relaxing a test that asserted the old id ("it is brittle
  anyway"). That assertion is the only automated notice that a default moved.
- Anti-pattern: changing the shipped settings default as a side effect of moving
  a provider default. They are separate decisions about separate populations.

## Next
`verify-model.md`.
