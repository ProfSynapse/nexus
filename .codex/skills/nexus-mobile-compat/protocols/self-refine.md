# Protocol: self-refine

Context: skills decay unless they learn from use. Run this at the end of a
session that exercised this skill — a dependency vetted, an import moved, a
mobile crash diagnosed, or a checker run that surprised you.

## Mission
Improve this skill for next time using evidence from this session and user
feedback, and record the change.

## Steps
1. Review the session: what went smoothly, and where using this skill hit
   friction. Give particular weight to anything the checker got wrong — a false
   positive or, worse, a real crash it did not see. Those are script bugs, and
   the script is the skill's only mechanical guard.
2. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your own read of the session.
3. Pick the single smallest change that prevents the top friction from
   recurring. Favor sharpening an existing file over adding a new one. If the
   friction was a fact that had gone stale, fix the fact and check whether the
   surrounding claim can be replaced by a command that produces current truth.
4. Apply it to the right file: router, reference, protocol, or script.
5. Append an entry to `../refinement-log.md`: date, observation, change, files.
6. Re-run this skill's validation so the change does not regress it:
   ```bash
   python3 /tmp/skill-crafter/skills/skill-crafter/scripts/validate_skill.py \
     .codex/skills/nexus-mobile-compat
   node scripts/check-mobile-imports.mjs .
   ```
   If you changed the checker, you MUST also re-run it against a fixture with a
   known violation, so a change that silently stopped detecting anything cannot
   pass as a clean run.

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
This is terminal for a session. Report the change and the log entry to the user.
