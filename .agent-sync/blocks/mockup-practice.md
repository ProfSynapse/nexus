## Mockup Practice

Substantial UI work gets a standalone mockup in `docs/mockups/` before any
production code: new views, panels, modals, settings tabs, chat surfaces, and
layout refactors. A tweak inside an existing layout does not — say so and
implement.

Do not improvise the process from this note. The `nexus-ui-mockups` skill is the
source of truth for how a mockup is built, revised, validated and handed off as a
plan's visual contract — load it before starting, and follow its protocols and
its `check_mockup.py` validator.

Implementation is a separate job under `src/` and is governed by CLAUDE.md's hard
rules (`styles.css`, `registerDomEvent`, no dynamic `innerHTML`). Mockup-only
liberties never travel into plugin code.
