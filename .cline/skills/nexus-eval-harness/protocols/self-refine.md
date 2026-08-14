# Protocol: self-refine

Context: skills decay unless they learn from use. Run this at the end of a
session that exercised this skill.

## Mission
Improve this skill for next time using evidence from this session and user
feedback, and record the change.

## Steps
1. Review the session: what went smoothly, and where did using this skill hit
   friction. Anything the harness did that this skill did not predict is the
   strongest candidate.
2. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your own read of the session.
3. Pick the single smallest change that prevents the top friction from
   recurring. Favor sharpening an existing file over adding a new one.
4. Apply it to the right file: router, reference, protocol, or the checker. If
   the friction was a fixture mistake a script could have caught, the fix
   belongs in `../scripts/check_scenarios.py`, not in prose.
5. You MUST NOT add a scenario list, config list, model name, pass rate or line
   number while refining. Those rot within a release and then mislead; add the
   command that derives them instead.
6. Append an entry to `../refinement-log.md`: date, observation, change, files.
7. Re-run the validation so the change does not regress this skill:

   ```bash
   python3 .claude/skills/nexus-eval-harness/scripts/check_scenarios.py
   python3 /tmp/skill-crafter/skills/skill-crafter/scripts/validate_skill.py \
     .claude/skills/nexus-eval-harness --quiet-next
   ```

## Guidelines
- Pattern: one evidence-backed fix per session beats a speculative rewrite. The
  log should read as a history of real problems solved.
- Pattern: when the user gives feedback, encode it in a file or a check so it
  holds without them repeating it.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router during refinement. New detail goes in a
  folder.

## Next
This is the terminal protocol for a session. Report the change and the log entry
to the user.
