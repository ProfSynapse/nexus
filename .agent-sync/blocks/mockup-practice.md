## Mockup Practice

For substantial UI work, create a mockup before touching production code. This is the default path for new views, modal redesigns, interaction-heavy flows, layout refactors, and any feature where we should review the UX shape before wiring real state.

**Standard workflow:**
- Put mockups in `docs/mockups/`
- Prefer standalone HTML/CSS/JS with no framework or build step
- Use realistic Nexus copy and representative sample data
- Reuse the same visual language and constraints we expect in the plugin: Obsidian-like theme tokens, accessible controls, desktop/mobile awareness, and explicit empty/loading/error states when relevant
- Simulate interactions locally in the mockup when needed, and label simulated persistence clearly as mock-only
- After the mockup is reviewed, implement the real UI in plugin code and follow all normal Obsidian rules (`styles.css`, `registerDomEvent`, no dynamic `innerHTML`, etc.)

**File shape:**
- Default to `docs/mockups/<feature-name>.html` with companion `.css` and `.js` files for larger mockups
- A single self-contained HTML file is acceptable for very small previews

**Reference patterns:**
- `docs/mockups/task-board-view.html` is the main reference for interactive mockups with separate assets
- `docs/mockups/compaction-indicator-preview.html` is the reference for compact one-file previews

**Recommended skill:**
- Use the vault-specific `nexus-ui-mockups` skill for UI mockup work before implementation
