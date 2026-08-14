# Protocol: self-refine

Context: this skill's subject is a set of files that change every time a provider
ships something, so it decays faster than most. Run this at the end of a session
that added, changed or verified a model.

## Mission
Make the next model session shorter using evidence from this one, and record the
change.

## Steps
1. Review the session. Where did this skill send you straight to the right file,
   and where did you have to read source it should have pointed at?
2. Delete anything you found stale. Model ids, prices, context windows, provider
   lists, capability tables, pass-rate baselines and line numbers MUST NOT
   accumulate here — this skill describes a list that changes weekly, and a copy
   of that list embedded in it is wrong within days. Replace any you find with a
   command that produces current truth.
3. If you hit a failure whose cause was not obvious from the symptom, add a row
   to the symptom table in `../references/consumers.md` or to the impostors
   section of `../references/smoke-harness.md`. Symptom→cause entries are the
   highest-value refinement this skill accepts.
4. Ask the user for one concrete correction if any is available. Their read of
   what was missing outranks yours.
5. Check whether the fix is mechanical and stable. If it is, it belongs in
   `../scripts/check_model_registry.py` as a new check rather than in prose — a
   rule a human has to remember is a rule that gets skipped. Add no list of real
   model ids or provider names to that script; every check discovers its subject
   from the tree, and one that cannot be written that way is judgment and stays
   in a reference.
6. Apply the single smallest durable fix. Sharpen an existing file before adding
   a new one, and put new detail in `../references/`, NEVER in the router.
7. Append to `../refinement-log.md`: date, observation, change, files touched.
8. Re-run the checks:

   ```bash
   python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
     --repo-root .
   python3 /tmp/skill-crafter/skills/skill-crafter/scripts/validate_skill.py \
     .claude/skills/nexus-model-updates
   ```

   (Use whatever path skill-crafter is installed at.) Resolve anything they flag.

## Guidelines
- Pattern: one evidence-backed change per session. The log should read as a
  history of real problems, not a changelog of rewrites.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router. If a step needs explaining, the explanation
  goes in a reference and the router keeps the pointer.

## Next
This is the terminal protocol. Report the change and the log entry to the user.
