# Protocol: revise-mockup

Context: runs when a mockup already exists for the surface in question — a
review round produced changes, a later redesign supersedes it, or the UI has
shipped and the mockup's status is in question. Mockups in this repo get cited
by plans and by tests, so editing one in place is not always safe.

## Mission
Apply the change to the right file, without invalidating anything that already
cites the existing mockup.

## Steps
1. Find out who cites it. Search `docs/plans/`, `docs/`, `tests/`, `src/` and
   `styles.css` for the mockup's filename. A plan that names it as its visual
   contract, or a test that lifted copy strings from it, is depending on the
   bytes you are about to change.
2. Choose the mode, then say which you chose and why:
   - **Revise in place** when the mockup is still under review and nothing has
     been blessed against it. Iterate freely.
   - **Supersede with a new file** when a plan already cites it or the design has
     moved to a new version. Add a suffixed sibling
     (`<feature-name>-v2-<focus>.html`) and leave the cited file untouched —
     this is the convention the existing multi-version mockups follow.
   - **Retire** when the UI has shipped and nobody cites it. Deleting is allowed;
     what is not allowed is leaving a dangling citation behind (step 5).
3. Apply the change following `build-mockup.md` from its step 4 onward: token
   block, production naming, states, honesty pass.
4. Validate: run
   `python3 .claude/skills/nexus-ui-mockups/scripts/check_mockup.py docs/mockups`
   from the repo root. You MUST fix every error, including ones the edit did not
   introduce but the file now carries.
5. Repair citations. If you superseded or retired a file, every reference to it
   MUST be updated in the same change — the plan that names the visual contract,
   and any comment in `styles.css` or `src/` that points at it. Production
   comments in this repo already cite a mockup file and line numbers that no
   longer exist anywhere; do not add more. See `../references/handoff.md`.
6. Stop condition: the checker exits clean, the chosen mode is stated, and no
   citation points at a file or a version that is gone.

## Guidelines
- Pattern: when in doubt between revising and superseding, supersede. A stale
  extra file is cheap; a blessed contract that silently changed under a plan is
  not.
- Pattern: put the version's focus in the filename, not just a number, so the
  reader knows what the new file is for.
- Anti-pattern: editing a mockup to match what production ended up shipping. The
  mockup records the decision that was made; production records what exists. If
  they must agree, update the plan, not the history.

## Next
Return to `../references/handoff.md` for serving and review. When the session
ends, run `self-refine.md`.
