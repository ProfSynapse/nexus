# Honest mockups: promising only what the plugin can render

Context: read while building or revising a mockup, alongside `fidelity.md`. That
file is about looking right; this one is about being buildable. In this repo an
accepted mockup becomes a plan's visual contract and sometimes the source of test
constants, so every detail it shows is a commitment somebody has to honor.

## Key idea
A mockup is a free-form HTML page and the plugin is not. Anything the mockup can
draw that Obsidian's components, the plugin's rules, or a phone cannot reproduce
turns into either an implementation compromise nobody agreed to or a rewrite. The
job is to draw inside the real constraints, and to mark clearly the few places
where you deliberately did not.

## Obsidian's form primitives have a shape
Production builds forms with Obsidian's component classes — `Setting` for labeled
rows, `DropdownComponent`, `TextComponent`, `TextAreaComponent`, `ButtonComponent`
— and each renders a fixed DOM and layout you do not get to redesign. A bare
`<select>` or `<input>` in a mockup is a shortcut, and it has already cost this
repo a substitution pass during implementation: a shipped plan carries an explicit
"the mockup used bare HTML for forms; production should use…" section mapping each
control back to its primitive.

So either mock the row the primitive actually produces (label and description on
the left, control on the right, in a `.setting-item`), or leave the bare control
in and note beside it which primitive will replace it. `Setting`'s layout is
mandatory; if your design needs something it cannot do, that is a finding worth
surfacing in review, not a detail to draw past.

## Label what is simulated
Any interaction the mockup fakes — persistence, network, model output, a long
job — says so in the visible copy ("updated in this mock", "sample response").
Reviewers cannot tell simulation from specification by looking, and the moment
someone believes a fake is real, the mockup has started lying.

## Mark what will not ship as drawn
When a variant is aspirational, put the caveat in the mockup, not in the chat
message that accompanied it — the file outlives the conversation. The strongest
example in this repo is a redesign that offered three material treatments and
stated inside the page which one production would ship and which used an effect
that costs Android frame rate and would not ship as-is. That one sentence saved
the reviewer from blessing something the plugin could not afford.

Recurring places where a mockup can outrun the plugin:
- **Effects with a cost.** Heavy `backdrop-filter` or per-scroll compositing is
  cheap in one static page and expensive in a live view on a phone.
- **Capabilities that do not exist.** Data the plugin does not have, a tool that
  is not registered, a provider feature not every model supports. If the surface
  depends on one, check it against the code (or the sibling skills) before
  drawing it, and say in the mockup that it is production-ahead.
- **Desktop-only mechanics** in a surface that also ships to phones.

## Mockup liberties are not precedent
`eslint` ignores `docs/`, and the plugin bundle never includes it, so inline
`<style>` blocks, `addEventListener`, `innerHTML` and hardcoded values are all
fine inside a mockup and nothing in CI will object. None of that carries into
`src/`, where CLAUDE.md's hard rules apply — styles in `styles.css`,
`registerDomEvent`, no `innerHTML` with dynamic content, no top-level Node
imports. Write the mockup for legibility; write production for the rules.

The corollary is that no automated check protects a mockup either. The skill's
own `scripts/check_mockup.py` is the only thing standing between a broken mockup
and a reviewer's browser, which is why the protocols run it before review.

## Lookup
- Hard rules for production code: `CLAUDE.md` at the repo root.
- Phone and plugin-store constraints: the `nexus-mobile-compat` skill.
- Whether a capability behind the UI exists: the `nexus-agents` skill.
- Proving the implemented UI in the running plugin: the `nexus-testing` skill.
