# Protocol: build-mockup

Context: runs when a Nexus UI surface is new or is being substantially reshaped
and the UX should be reviewed before any plugin code is written. Produces a
standalone page under `docs/mockups/` that a human can open, judge, and bless.

## Mission
Deliver a reviewable mockup of the proposed surface that looks like the real
product, shows the states implementation would otherwise discover late, and is
honest about what the plugin can render.

## Steps
1. Confirm both the product surface and the artifact are warranted. State the
   concrete user problem, what existing Nexus affordance fails to cover it, and
   the smallest new interaction that closes the gap. If the proposal mostly
   duplicates an existing toolbar, status, safety, or recovery mechanism, stop
   and review the product scope before drawing. Once the need is established, a
   new view, panel, modal, settings tab, chat surface, board, or layout refactor
   gets a mockup; a tweak inside an existing layout does not.
2. Find the production surface you are changing before drawing anything. Locate
   the view or tab under `src/` and its rules in `styles.css` (search for the
   class prefix the surface uses). A redesign starts from what ships today, not
   from a blank page — anything you leave out of the mockup reads as a deletion.
3. Name the files. `docs/mockups/<feature-name>.html`, kebab-case, plus
   `<feature-name>.css` and `<feature-name>.js` companions sharing the same stem
   when the mockup is interactive. A small static preview may stay one
   self-contained file.
4. Write the token block first. Run
   `python3 .claude/skills/nexus-ui-mockups/scripts/theme_tokens.py --emit` from
   the repo root to get the variables production relies on, and declare them in
   the mockup's own `:root`. Nothing loads Obsidian's stylesheet or the plugin's
   `styles.css`, so an undeclared variable renders as nothing. Read
   `../references/fidelity.md` for how to pick values and cover both themes.
5. Build the proposed UI using production's own class names, and prefix every
   piece of mockup-only chrome (state switchers, device frames, annotation bars)
   with `mock-`, so the reviewer and the implementer can both see where the
   proposal ends. Details in `../references/fidelity.md`.
6. Show the states that otherwise surface during implementation: empty, loading,
   and error where they exist; hover, focus, selected where they carry meaning;
   and the phone width for any surface that ships to mobile. A state switcher in
   `mock-` chrome beats eleven screenshots.
7. Keep it buildable. Apply `../references/honest-mockups.md`: mock Obsidian's
   form primitives as they actually render, label simulated persistence in the
   visible copy, and mark anything drawn that is not intended to ship as drawn.
8. Validate. Run
   `python3 .claude/skills/nexus-ui-mockups/scripts/check_mockup.py docs/mockups/<feature-name>.html`
   from the repo root. You MUST fix every error before showing the mockup to
   anyone; read each warning and either fix it or be able to say why it stands.
9. Serve it and review with the user, iterating in the mockup rather than in
   `src/`. Procedure in `../references/handoff.md`.
10. Stop condition: the checker exits clean, the user has seen the served page,
    and their feedback is either applied or written down.

## Guidelines
- Pattern: copy the real thing. Class names, spacing tokens, copy strings and
  icon names lifted from production make implementation a port instead of a
  reinterpretation.
- Pattern: realistic sample data — actual workspace, task, conversation, model
  and settings names from this repo. Lorem ipsum hides layout problems that real
  strings expose.
- Anti-pattern: inventing a visual language because it is faster in a blank file.
  A mockup that does not look like Obsidian gets judged on the wrong axis.
- Anti-pattern: wiring the mockup into the plugin runtime. It stays standalone
  with no framework, bundler, or plugin bootstrapping unless the user asks.
- Anti-pattern: treating what is legal in `docs/mockups/` (inline styles,
  `addEventListener`, `innerHTML`) as precedent for `src/`.

## Next
Run `../references/handoff.md` to serve, bless, and hand the mockup to a plan.
Implementation of the real UI is a separate job under `src/` governed by
CLAUDE.md and the sibling skills. When the session ends, run `self-refine.md`.
