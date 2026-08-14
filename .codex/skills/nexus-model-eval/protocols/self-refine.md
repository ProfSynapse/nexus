# Protocol: self-refine

Context: this skill claims things about a harness that changes underneath it.
Run this at the end of a session that used `nexus-model-eval`, especially one
where an attribution took longer than it should have or a claim here was wrong.

## Mission
Improve this skill using evidence from this session, and record the change.

## Steps
1. Review the session: which failure took the longest to attribute, what did you
   have to read the harness source to learn, and where did this skill send you
   somewhere that did not match the tree.
2. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your read of the session.
3. Pick the single smallest change that stops the top friction recurring. Prefer
   sharpening an existing file over adding one.
4. Apply it in the right place: a new failure signature belongs in
   `../references/harness-artifacts.md` as symptom → cause → proof; a grading
   rule in `../references/what-is-graded.md`; a step in a protocol; anything
   mechanical in a script. A fact that will go stale — a model name, a score, a
   scenario count, a line number — MUST become a command that produces current
   truth instead.
5. Check the boundary: if the change is really about running, configuring or
   fixing the harness, it belongs to `nexus-eval-harness`. Put it there, or name
   it there, rather than growing a second copy here.
6. Re-run the checks so the change does not regress the skill:
   ```bash
   python3 .claude/skills/nexus-model-eval/scripts/check_advertised_tools.py
   python3 .claude/skills/nexus-model-eval/scripts/summarize_eval.py --help
   ```
7. Append one line to `../refinement-log.md`: date, observation, change, files.
8. Report the change and the log entry to the user.

## Guidelines
- Pattern: one evidence-backed fix per session. The log should read as a history
  of real problems solved, not a changelog of tidying.
- Pattern: when a claim here turned out to be wrong, replace it with the command
  or the source file that would have shown the truth, not with a corrected claim.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing `SKILL.md`. New detail goes in a folder.

## Next
This is the terminal protocol for a session using this skill.
