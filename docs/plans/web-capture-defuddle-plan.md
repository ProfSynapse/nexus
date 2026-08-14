# Web capture via Defuddle — investigation + plan

Status: **proposed** (investigation complete, no code written)
Date: 2026-08-14
Related: `src/agents/apps/webTools/`, kepano/obsidian-skills `skills/defuddle`

## Why look at this

`web capture-markdown` does not extract anything itself. It drives Obsidian's
Web Viewer:

- `captureToMarkdown.ts` opens a Web Viewer leaf (`openWebViewerUrl`), waits for
  it to settle, then invokes the core-plugin command
  `webviewer:save-to-vault` (`utils/webViewer.ts:31`) and *hunts the filesystem*
  for whatever file that command produced (`findCreatedMarkdownFile`,
  `utils/webViewer.ts:175`).
- It is gated on `hasWebViewerSaveCommand(app)` (`utils/webViewer.ts:215`), so
  it silently does nothing useful if the user has the Web Viewer core plugin
  disabled.
- The whole `webTools` app is desktop + Electron only.

Consequences: mobile can't capture at all, a core plugin is a hard dependency,
the workspace is mutated (a tab opens) as a side effect of a data operation, the
output format is whatever Obsidian decided, and we get no page metadata back.

Defuddle is the extraction library behind Obsidian Web Clipper, so adopting it
directly gives us the same extraction quality without renting Obsidian's UI.

## What Defuddle actually is (verified against the published tarball)

`defuddle@0.19.2`, MIT. Measured from `npm pack defuddle@0.19.2`:

| Entry | Size (unminified) | Contents |
|-------|------------------|----------|
| `defuddle` (`.`) | 324,454 B | Extraction only — returns cleaned **HTML** |
| `defuddle/full` | 750,156 B | Adds Turndown + mathml-to-latex → **Markdown** |
| `defuddle/node` | 3,212 B | Requires `linkedom`/`jsdom` — not for us |

Dependency shape: one runtime dep (`commander`, used only by the CLI);
`turndown`, `temml`, `linkedom`, `mathml-to-latex` are **optional** deps and are
pre-bundled into the `full` entry.

**Mobile safety — the decisive check.** Node built-ins appear in exactly two
files in `dist/`: `fetch.js` and `cli.js`. Neither is reachable from `.` or
`/full` (`grep -c "node:http" dist/index.js` → `0`; same for `require("path")`).
So the browser entries violate none of the CLAUDE.md mobile rules. We should
still `await import()` them lazily inside the tool rather than top-level, per
rule 2.

**Detached-document safety.** Defuddle uses `getComputedStyle` (hidden-element
and small-image removal), but every call goes through a guard:

```js
const w = getWindow(el.ownerDocument);
return w && typeof w.getComputedStyle === 'function' ? w.getComputedStyle(el) : null;
```

and call sites use optional chaining on the result. A document produced by
`new DOMParser().parseFromString(html, 'text/html')` has `defaultView === null`,
so those passes degrade to no-ops instead of throwing. Extraction still works;
CSS-hidden clutter survives. That is an acceptable trade for the fetch path and
a non-issue for the live-DOM path (below).

**Return shape.** `parse()` yields `content` plus `title`, `author`,
`description`, `domain`, `favicon`, `image`, `language`, `published`, `site`,
`metaTags`, `schemaOrgData`, `wordCount`, `parseTime` — i.e. ready-made
frontmatter, which the current implementation cannot give us at all.

## Proposal

Two extraction paths behind the existing tool, plus a deletion.

### A. Fetch path (new capability — works on mobile)

`requestUrl(url)` → `DOMParser` → `new Defuddle(doc, { url, markdown: true }).parse()`
→ write the file ourselves with Defuddle's metadata as frontmatter.

No browser leaf, no core plugin, no workspace mutation, no CORS problem
(`requestUrl` bypasses it), deterministic output path. This is the first
`webTools` capability that could run on mobile — note the agent is currently
registered desktop-only, so exposing it means gating per-tool instead of
per-agent.

Limits: no JS execution (SPA shells come back empty) and no session cookies
(paywalled/logged-in pages).

### B. Live-DOM path (desktop, replaces the save-command dependency)

We already hold the Web Viewer's `webContents` (`getWebViewerContents`,
`utils/webViewer.ts:146`). Pull `document.documentElement.outerHTML` via
`executeJavaScript`, then run the same Defuddle call over it.

This keeps everything the current implementation is good at — JS-rendered pages,
authenticated sessions — while dropping `webviewer:save-to-vault`, the
`hasWebViewerSaveCommand` gate, and `findCreatedMarkdownFile` entirely. It also
runs Defuddle against a *live* document, so `getComputedStyle` works and
clutter removal is at full strength.

### C. Selection + removal

`capture-markdown` tries A first; falls back to B on desktop when the fetch is
non-2xx, the content type isn't HTML, or `wordCount` comes back under a
threshold (the SPA-shell signal). Keep the old save-to-vault route behind a
setting for one release, then delete it along with the three helpers above.

## Costs and risks

- **Bundle.** Obsidian plugins ship one `main.js`, so a lazy `import()` still
  inlines `defuddle/full` (750 KB unminified) into the bundle. Minified cost
  needs measuring before committing — if it lands badly, the fallback is the
  core entry (324 KB) plus our own HTML→Markdown, which means reimplementing
  Turndown and is not worth it. Measure first.
- **0.x API.** Pre-1.0; pin the exact version and keep the call behind our own
  wrapper so a breaking change touches one file.
- **Quality regression risk.** Web Viewer's save may be tuned beyond stock
  Defuddle. Compare outputs on ~10 real pages (article, docs, blog, SPA,
  paywalled) before deleting path C.

## Steps

1. Measure minified bundle delta with `defuddle/full` added.
2. `WebContentExtractor` service wrapping Defuddle (one call site).
3. Path A + frontmatter from metadata + unit tests over saved HTML fixtures.
4. Path B via `executeJavaScript`; drop the save-command dependency.
5. Auto-selection + settings flag for the legacy route.
6. Side-by-side quality comparison, then delete legacy + helpers.
7. Decide per-tool mobile gating for the fetch path.
