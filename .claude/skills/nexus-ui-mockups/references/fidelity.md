# Fidelity: making a mockup look like Obsidian and like Nexus

Context: read while building or revising a mockup. A Nexus mockup is judged on
whether the proposed surface would fit inside Obsidian; if it does not look like
the product, reviewers argue about the wrong things and the implementer has to
re-derive the styling anyway.

## Key idea
Nexus's production CSS is almost entirely *variables it does not define*. It
inherits Obsidian's theme tokens and adds a small set of its own. A standalone
mockup inherits nothing — no Obsidian stylesheet, no `styles.css` — so fidelity
starts with declaring that same token set in the mockup's own `:root` and then
using it everywhere instead of literal colors and pixel spacings.

## The token block
Run, from the repo root:

    python3 .claude/skills/nexus-ui-mockups/scripts/theme_tokens.py --emit

It reads the current `styles.css` and splits the variables into two groups, so
this never goes stale:

- **Inherited** — used by production but defined nowhere in `styles.css`. Most
  come from Obsidian's theme (`--background-primary`, `--text-normal`,
  `--interactive-accent`, `--radius-*`, `--font-ui-*`, `--color-*`, the `*-rgb`
  companions). A few are set on an element at runtime by the plugin's TypeScript
  rather than by any stylesheet, and a handful are neither — production rules
  referencing a variable nothing defines, which silently do nothing. Declare the
  ones your surface uses with values approximating Obsidian's default theme, and
  if you notice one of the orphans, report it rather than designing around it.
- **Nexus-defined** — declared in `styles.css` itself: the `--space-*` spacing
  scale and the `--glass-*` material tokens. `--emit` prints these declarations
  verbatim. Paste them in rather than inventing spacing, so the mockup's rhythm
  is the one production will produce.

A variable used but never declared is invisible failure: the browser drops the
declaration and the mockup renders subtly (or completely) wrong. `check_mockup.py`
treats that as an error.

## Both themes
Obsidian ships light and dark, and `styles.css` carries a real set of
`body.theme-light` overrides — light is not an afterthought in production, so it
should not be one in the mockup. Drive it with the same hooks:

- put `theme-dark` or `theme-light` on `<body>`, matching production's selectors,
  and/or
- override the token block under `@media (prefers-color-scheme: light)` or a
  `data-theme` attribute so a reviewer can see both.

A dark-only mockup leaves the light palette to be improvised during
implementation, which is exactly the decision the mockup existed to make.

## Name classes the way production names them
Two naming systems live in `styles.css`, and mockups should use both:

- **Obsidian primitives**, styled by hooking their real class names —
  `.setting-item` and its `-info` / `-name` / `-description` / `-control`
  children, `.clickable-icon`, `.mod-cta`, `.modal-content`. Draw a settings row
  as a `.setting-item` and the port is mechanical.
- **Nexus's own prefixed classes** — `nexus-`, `chat-`, `message-`, `ws-`,
  `mcp-`, `tool-` and friends. Reuse the existing prefix for the surface you are
  redesigning; invent a new one only for genuinely new surfaces.

The mockups that ported most cleanly into production reused these names, so the
implementation diff was a name-preserving copy rather than a translation.

## Mark the scaffolding
Anything that exists only to make the mockup reviewable — the intro blurb, the
state-switcher toolbar, a phone bezel, an annotation callout — gets a `mock-`
prefixed class (`mock-page`, `mock-toolbar`, `mock-device`, `mock-screen`). No
production class starts with `mock-`, so the prefix is an unambiguous boundary:
everything under it is the frame, everything else is the proposal. It also tells
the implementer which CSS not to port.

## Phones are a real target
The plugin is not desktop-only. Production styles key off `body.is-mobile` and a
set of max-width media queries. For any surface that ships to phones (chat and
its input are the obvious ones), show the phone width — the existing mobile
mockups render an inline device frame around 390px wide and set `is-mobile` on
the body alongside the theme class. Keyboard-avoidance and the input area are
where mobile layout actually breaks, so draw those explicitly.

## Icons, fonts, and text
- Icons in production are drawn with Obsidian's `setIcon()` using Lucide names.
  Inline an SVG that matches the intended Lucide glyph and record the icon name
  next to it (a comment or `data-icon`), so implementation is a lookup rather
  than a new decision.
- Fonts: use `var(--font-interface)` and `var(--font-monospace)` with a system
  fallback stack, rather than naming one designer font as the primary — the user's
  theme decides.
- Copy: write the real strings. They get read aloud in review, they end up in the
  plan, and in at least one shipped feature they were lifted verbatim into test
  constants.

## Lookup: where to check a claim
- Token usage and every production selector: `styles.css`.
- Which classes a surface already uses: search `styles.css` for its prefix, then
  the matching renderer under `src/`.
- Mobile behavior of the plugin: `src/utils/platform.ts` plus the `is-mobile`
  blocks in `styles.css`.
- Existing convention for anything above: open the newest files in
  `docs/mockups/` — they are the most production-faithful.
