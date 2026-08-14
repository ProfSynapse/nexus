# Protocol: self-refine

Context: skills decay unless they learn from use. Run this at the end of a
session that built or revised a Nexus mockup.

## Mission
Improve this skill for next time using evidence from this session and the user's
feedback, and record the change.

## Steps
1. Review the session: where did the mockup work go smoothly, and where did this
   skill leave you guessing or send you somewhere wrong.
2. Ask the user for one concrete piece of feedback if any is available — most
   usefully, what they had to correct in the mockup after you showed it. Their
   correction outranks your own read of the session.
3. Check whether the friction is mechanical. A rule that can be checked belongs
   in `../scripts/check_mockup.py`, not in prose; a rule that needs judgment
   belongs in a reference. You MUST NOT encode a list of specific real-world
   things (banned colors, approved class names) in the script — those rot.
4. Apply the single smallest change that prevents the top friction from
   recurring, in the right file: router, reference, protocol, or script. Favor
   sharpening an existing file over adding one.
5. If a claim in this skill turned out to be wrong about the repo, fix it against
   the tree in the same pass and say so in the log entry.
6. Append an entry to `../refinement-log.md`: date, observation, change, files.
7. Re-run the validation so the change does not regress anything:
   `python3 .claude/skills/nexus-ui-mockups/scripts/check_mockup.py` from the
   repo root, and re-read the router to confirm it stayed slim.

## Guidelines
- Pattern: one evidence-backed fix per session beats a speculative rewrite. The
  log should read as a history of real problems solved.
- Pattern: when the user corrects the same visual detail twice, that detail
  belongs in `../references/fidelity.md`.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router. New detail goes in a folder.

## Next
This is the terminal protocol for a session. Report the change and the log entry
to the user.
