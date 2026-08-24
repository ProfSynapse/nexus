# Protocol: self-refine

Context: skills decay unless they learn from use. Run this at the end of a
session that exercised `nexus-testing`. This skill has one standing debt on top
of the usual: `live-loop.md` was written without ever being run, so the first
session that executes it owes this log a correction.

## Steps

1. Review the session: what went smoothly, and where using this skill hit
   friction. A command that did not exist, a path that had moved, a lane that
   was not where the skill said — those are the entries worth having.
2. If you ran any part of `live-loop.md` against a real Obsidian install, you
   MUST record which commands worked verbatim, which needed different syntax,
   and which do not exist. That protocol's status line stays "documented, never
   run" until someone does this; update it when they have.
3. Ask the user for one concrete piece of feedback if any is available. Their
   correction outranks your read of the session.
4. Pick the single smallest change that prevents the top friction from
   recurring. Favor sharpening an existing file over adding one. If the friction
   was something mechanically checkable, prefer extending a script in
   `../scripts/` over adding prose.
5. Apply it to the right file: router, reference, protocol, or script. New
   detail goes in a folder, never in the router.
6. Verify no stale content crept in. This skill must contain no test counts, no
   lane inventories and no env-var tables — only commands that produce them.
7. Append an entry to `../refinement-log.md`: date, observation, change, files.
8. Re-run the checks so the change did not regress anything:

   ```bash
   python3 <installed-skill-crafter>/scripts/validate_skill.py .codex/skills/nexus-testing
   python3 .codex/skills/nexus-testing/scripts/check_live_lane_gates.py
   python3 .codex/skills/nexus-testing/scripts/check_catalog_target.py
   ```

## Guidelines

- Pattern: one evidence-backed fix per session beats a speculative rewrite. The
  log should read as a history of real problems solved.
- Pattern: when the user corrects you, encode the correction in a file or a
  check so it holds without them repeating it.
- Anti-pattern: refining in the abstract. If nothing went wrong and the user has
  no feedback, log "no change" and stop.
- Anti-pattern: growing the router. It is a router.

## Next

This is the terminal protocol for a session. Report the change and the log entry
to the user.
