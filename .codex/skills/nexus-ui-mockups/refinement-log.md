# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

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
