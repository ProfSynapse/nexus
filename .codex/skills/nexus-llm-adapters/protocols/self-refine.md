# Protocol: self-refine

Context: this skill decays unless it learns from use. Run it at the end of a
session that added, changed, or debugged an adapter.

## Mission
Make the next adapter session shorter using evidence from this one, and record
the change.

## Steps
1. Review the session. Where did this skill send you to the right place, and where
   did you have to read source it should have pointed at?
2. If you hit a symptom that was not in `references/symptoms.md`, add a row: the
   symptom in the words a user would say it, the mechanism, and the reference that
   explains it. This is the highest-value refinement this skill accepts.
3. Ask the user for one concrete correction if any is available. Their read of
   what was missing outranks yours.
4. Apply the single smallest durable fix. Sharpen an existing file before adding a
   new one, and put new detail in `references/`, NEVER in the router.
5. Check whether the fix is mechanical and stable. If it is, it belongs in
   `scripts/`, not in prose — a rule a human has to remember is a rule that gets
   skipped.
6. Delete anything you found stale. Provider lists, model ids, capability tables
   and line numbers MUST NOT accumulate here; replace them with a command that
   produces current truth.
7. Append to `../refinement-log.md`: date, observation, change, files touched.
8. Re-run the validator on this skill directory:
   `python3 <installed-skill-crafter>/scripts/validate_skill.py .codex/skills/nexus-llm-adapters`.
   Resolve the installed skill-crafter path first, then resolve anything it flags.

## Guidelines
- Pattern: one evidence-backed change per session. The log should read as a
  history of real problems, not a changelog of rewrites.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router. If a step needs explaining, the explanation
  goes in a reference and the router keeps the pointer.

## Next
This is the terminal protocol. Report the change and the log entry to the user.
