# Protocol: self-refine

Context: releases are infrequent and every one of them teaches something the
previous procedure did not cover. Run this at the end of a session that used this
skill, whether or not the release went smoothly.

## Mission
Fold what this release taught into the skill, and record it, so the next release
does not rediscover it.

## Steps
1. Review the session: which steps ran cleanly, and where did the procedure lag
   reality — a command that did not exist, a file that had moved, a failure the
   protocol did not anticipate, a check that fired falsely.
2. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your read of the session.
3. Pick the single smallest change that prevents the top friction from recurring.
   Prefer, in order: a new check in `../scripts/check_release_ready.py` (a rule
   the machine can hold), a sharper step in an existing protocol, a correction in
   a reference. Adding a file is the last resort.
4. Apply it. If the friction was a **wrong claim**, verify the replacement against
   the tree before writing it — the whole point of this skill is that a release
   step nobody checked is a release that ships broken.
5. You MUST apply the edit to `<repo>/.skills/nexus-release/`, the sync source,
   and then run `npm run sync:skills`. An edit made only in a mirror
   (`.claude/`, `.codex/`, `.cline/`) is partly reverted on the next sync.
6. Append an entry to `../refinement-log.md`: date, observation, change, files.
7. Re-run the checks so the refinement did not regress the skill:
   ```bash
   python3 .claude/skills/nexus-release/scripts/check_release_ready.py
   python3 /path/to/skill-crafter/scripts/validate_skill.py .skills/nexus-release
   ```

## Guidelines
- Pattern: encode a correction as a check when it is mechanical. Prose the reader
  can skip is weaker than an exit code they cannot.
- Pattern: one evidence-backed fix per session. The log should read as a history
  of real releases, not a changelog of rewrites.
- Anti-pattern: refining in the abstract. If the release was clean and the user
  has no feedback, log "no change" and stop.
- Anti-pattern: growing `SKILL.md`. New detail goes in a protocol, a reference or
  the script.

## Next
Terminal. Report the change and the log entry to the user.
