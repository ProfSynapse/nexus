# Protocol: self-refine

Context: this skill decays as the exporter, the normalizer and the consumers
move. Run this at the end of a session that used it, while the friction is still
concrete.

## Mission
Make the smallest durable change that stops this session's friction from
recurring, and record it.

## Steps
1. Review the session: which step was ambiguous, what you had to discover by
   reading source, what the checks missed or flagged wrongly.
2. Ask the user for one concrete correction if any is available. Theirs outranks
   your read of the session.
3. Pick the single smallest fix. Prefer sharpening a protocol or extending a
   script over adding a file. If the friction was a claim that turned out to be
   false, correcting it is the fix.
4. Apply it here, under this skill's folder. Nothing that goes stale: no tool
   counts, no agent inventories, no line numbers — if the fact changes when the
   code changes, it belongs in a script that reads the source, not in prose.
5. Mirror the edit if it must survive a sync. This skill also exists under the
   repo's skill source directory, and `npm run sync:skills` copies that source
   over every agent root — so an edit made only here is reverted the next time
   anyone runs it. Copy the change into the source copy, or say plainly that you
   did not.
6. Re-run the validation: this skill's own scripts against a current export, plus
   the skill-crafter structure validator on this folder.
7. Append an entry to `../refinement-log.md`: date, observation, change, files.

## Guidelines
- Pattern: one evidence-backed fix per session. The log should read as a history
  of real problems solved.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router. New detail goes into a folder file.

## Next
Terminal. Report the change and the log entry to the user.
