# Protocol: self-refine

Context: skills decay as the code moves under them. Run this at the end of a
session that used `nexus-agents`, especially one where something in it turned out
to be wrong.

## Mission
Improve this skill using evidence from this session, and record the change.

## Steps
1. Review the session: which file did you actually open, what did you have to
   discover for yourself, and where did this skill send you somewhere that did
   not match the tree.
2. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your read of the session.
3. Pick the single smallest change that stops the top friction recurring. Prefer
   sharpening an existing file over adding one.
4. Apply it in the right place: a symptom belongs in `../references/failure-modes.md`,
   a step in a protocol, a mechanical rule in a script. A fact that will go stale
   — an inventory, a count, a line number — MUST become a command that produces
   current truth instead.
5. Re-run the checks so the change does not regress the skill:
   ```bash
   python3 .claude/skills/nexus-agents/scripts/check_documented_commands.py .claude/skills/nexus-agents
   ```
6. Append one line to `../refinement-log.md`: date, observation, change, files.
7. Report the change and the log entry to the user.

## Guidelines
- Pattern: one evidence-backed fix per session. The log should read as a history
  of real problems solved, not a changelog of tidying.
- Pattern: when a claim here turned out to be wrong, replace it with the command
  that would have shown the truth, not with a corrected claim.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing `SKILL.md`. New detail goes in a folder.

## Next
This is the terminal protocol for a session using this skill.
