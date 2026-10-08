# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-10-07 | Further user review rejected capability, tool, and timeout options:
the endpoint should behave like an ordinary inference provider with defaults. |
Sharpened the product-value gate to reuse existing provider defaults and avoid
turning implementation uncertainty into setup controls. |
`protocols/build-mockup.md`, `refinement-log.md`.

2026-10-07 | User questioned whether connection type changed endpoint behavior;
the selector duplicated the model's tools permission and was removed. |
No guidance change: the existing product-value gate already requires each
interaction to address an unmet need. Apply it to individual controls too. |
`refinement-log.md` only.

2026-08-21 | User review found the runtime-safety proposal disproportionate:
confined/reversible CRUD and the existing tool toolbar already covered most of
the intended value. The workflow gated on UI size but not product necessity. |
Added a product-value gate before drawing: name the unmet problem, existing
affordance gap, and smallest interaction; stop when the proposal mainly
duplicates current safety or inspection surfaces. | `protocols/build-mockup.md`,
`refinement-log.md`.

2026-08-21 | Visual QA of the runtime-safety mockup found that light-theme base
tokens changed while composite glass gradients inherited their dark computed
values from `:root`. | Added a targeted rule to redeclare theme-dependent
composite tokens under the light-theme hook. | `references/fidelity.md`,
`refinement-log.md`.

2026-08-14 | improve-skill pass: the skill was one prose file with no procedure,
no progressive disclosure, and nothing that could verify a mockup. It also had
never been checked against the tree. | Rebuilt as a router plus
`protocols/build-mockup.md`, `protocols/revise-mockup.md`,
`references/fidelity.md`, `references/honest-mockups.md`,
`references/handoff.md`, and two CLI scripts (`check_mockup.py`,
`theme_tokens.py`). Fidelity to the real Obsidian/Nexus surface and the
after-shipping life of a mockup were the two largest missing topics. | every file
in this skill.

- 2026-10-03: No change. User removed explanatory helper copy and required existing UI primitives; existing fidelity/handoff guidance already requires reuse, and the accepted contract records that correction.
- 2026-10-07 | Remote-agent mockup passed validation and production settings were inspected in the native Code-vault Settings window, including scrolling and empty-input validation. | No procedure change.
