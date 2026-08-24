# Protocol: self-refine

Context: run this at the end of a session that used nexus-storage. Storage
guidance decays as the schema, resolvers and appliers move; this is how the skill
keeps up without a rewrite.

## Mission
Turn one piece of friction from this session into a durable fix in this skill, and
record it.

## Steps
1. Review the session: which step landed cleanly, and where did you have to read
   Nexus source because this skill did not say enough — or said something the tree
   contradicted.
2. Ask the user for one concrete correction if any is available. Their correction
   outranks your own read of the session.
3. Pick the single smallest change that stops the top friction recurring. Prefer
   sharpening an existing file over adding one.
4. Apply it to the right place: a symptom entry in `../references/failure-modes.md`,
   a step in a protocol, a rule in `../references/schema-rules.md`, or a new check
   in `../scripts/check_schema_consistency.py` when the rule is mechanical.
5. If the fix corrects a factual claim, verify the correction against the tree
   before writing it. A wrong storage fact costs data.
6. Append an entry to `../refinement-log.md`: date, observation, change, files.
7. Re-run the checks so the change did not regress the skill:
   ```bash
   python3 .claude/skills/nexus-storage/scripts/check_schema_consistency.py .
   python3 <installed-skill-crafter>/scripts/validate_skill.py .claude/skills/nexus-storage
   ```

## Guidelines
- Pattern: one evidence-backed fix per session. The log should read as a history of
  real problems.
- Pattern: when the friction was "I could not tell whether X was consistent",
  that is a script, not a paragraph.
- Anti-pattern: adding inventories, version numbers or counts. They go stale and
  then mislead; name the file and give the command that produces current truth.
- Anti-pattern: growing SKILL.md. New detail goes in a folder.

## Next
This is the terminal protocol for a session. Report the change and the log entry to
the user.
