# Web Capture via Defuddle — Design Plan

**Status:** Design / pre-architecture
**Date:** 2026-08-14
**Author:** design discussion (ProfSynapse + Claude)
**Prompted by:** review of `kepano/obsidian-skills` (`skills/defuddle`)

## 1. Goal

Own our web-content extraction instead of renting Obsidian's Web Viewer UI for
it, and in doing so make web capture work on **mobile**, without the Web Viewer
core plugin, without opening a tab, and with page metadata attached.

## 2. What we do today, and why it hurts

`web capture-markdown` extracts nothing itself. It drives the Web Viewer:

1. `openWebViewerUrl` opens a leaf and `waitForWebViewerReady` waits for it
   (`src/agents/apps/webTools/utils/webViewer.ts`).
2. It invokes the **core-plugin command** `webviewer:save-to-vault`
   (`webViewer.ts:31`), gated on `hasWebViewerSaveCommand(app)` (`:215`).
3. It then **hunts the filesystem** for whatever file that command produced
   (`findCreatedMarkdownFile`, `:175`).

| Consequence | Detail |
|---|---|
| Mobile: impossible | The whole `webTools` app is desktop + Electron gated |
| Hard dependency | Silently useless if the user disabled the Web Viewer core plugin |
| Side effects | A data operation mutates the workspace by opening a tab |
| No control | Output format and filename are Obsidian's choice; we reverse-engineer the result |
| No metadata | Title, author, publish date, site — all discarded |

## 3. Mental model

> **Fetch is a transport problem; extraction is a parsing problem. Today we
> conflate them by borrowing a browser to do both.**

Separating them gives two independent transports (HTTP fetch, live browser DOM)
feeding one extraction pipeline. Most pages need only the cheap transport.

## 4. Defuddle — verified properties

Everything below was measured against the published tarball
(`npm pack defuddle@0.19.2`), not the README. Defuddle is the extraction library
behind Obsidian Web Clipper; MIT licensed; one runtime dep (`commander`, used
only by its CLI).

### 4.1 Mobile safety — the decisive check

Node built-ins appear in exactly two files in `dist/`: `fetch.js` and `cli.js`.
Neither is reachable from the `.` or `/full` entries — verified
`grep -c "node:http" dist/index.js` → `0`, same for `require("path")`.

So the browser entries violate none of the CLAUDE.md mobile rules. We still
`await import()` them inside the tool rather than at module top level, per rule 2.

### 4.2 Detached-document safety

Defuddle calls `getComputedStyle` for hidden-element and small-image removal,
but always through a guard:

```js
const w = getWindow(el.ownerDocument);
return w && typeof w.getComputedStyle === 'function' ? w.getComputedStyle(el) : null;
```

with optional chaining on every call site. A `DOMParser` document has
`defaultView === null`, so those passes degrade to no-ops rather than throwing.
Extraction works; CSS-hidden clutter survives. Acceptable on the fetch transport,
irrelevant on the live-DOM transport where a real window exists.

### 4.3 Measured bundle cost (esbuild, `--bundle --minify --format=esm`)

| Entry | Minified | Gzipped | Contents |
|---|---|---|---|
| `defuddle` | 316 KB | 92 KB | Extraction → cleaned **HTML** |
| `defuddle/full` | 745 KB | 213 KB | Adds Turndown + temml + mathml-to-latex → **Markdown** |
| `defuddle/node` | — | — | Needs `linkedom`/`jsdom`; not for us |

Obsidian plugins ship a single `main.js`, so a lazy `import()` still lands in the
bundle. 745 KB is a lot to add for the markdown step alone.

### 4.4 Return shape

`parse()` yields `content` plus `title`, `author`, `description`, `domain`,
`favicon`, `image`, `language`, `published`, `site`, `metaTags`, `schemaOrgData`,
`wordCount`, `parseTime` — ready-made frontmatter we currently cannot produce.

## 5. Key decision: core entry + Obsidian's own `htmlToMarkdown`

Obsidian exports `htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string`
as public API. So the markdown step is already in the app, and we should not
bundle a second converter to do it:

> **`requestUrl`/live DOM → Defuddle core (cleaned HTML) → `htmlToMarkdown()`**

| | `defuddle/full` | core + `htmlToMarkdown` |
|---|---|---|
| Bundle | 745 KB / 213 KB gz | **316 KB / 92 KB gz** |
| Markdown conventions | Turndown defaults | **Obsidian's own** — matches paste-as-markdown |
| Math → LaTeX | Yes (temml, mathml-to-latex) | No |

Saving 429 KB and getting output that matches what Obsidian produces everywhere
else is worth losing MathML→LaTeX conversion. Defuddle core still standardises
headings, code blocks and footnotes in the HTML it emits, so most of the
normalisation survives; only the math conversion step is lost. Revisit only if
math-heavy captures become a real complaint.

## 6. Two transports, one pipeline

### 6.1 Fetch transport — new capability, mobile-capable

`requestUrl(url)` → `DOMParser.parseFromString(html, 'text/html')` → Defuddle →
`htmlToMarkdown` → we write the file ourselves with metadata frontmatter.

No leaf, no core plugin, no workspace mutation, no CORS (`requestUrl` bypasses
it), deterministic output path. This would be the **first `webTools` capability
that can run on mobile**, which means per-tool rather than per-agent platform
gating (§8).

Limits: no JS execution (SPA shells come back near-empty) and no session cookies
(paywalled or logged-in pages).

### 6.2 Live-DOM transport — desktop, drops the save-command dependency

We already hold the Web Viewer's `webContents` (`getWebViewerContents`,
`webViewer.ts:146`). Pull `document.documentElement.outerHTML` via
`executeJavaScript`, then run the same pipeline.

Keeps what the current implementation is genuinely good at — JS-rendered pages,
authenticated sessions — while deleting `webviewer:save-to-vault`,
`hasWebViewerSaveCommand` and `findCreatedMarkdownFile`. It also runs Defuddle
against a live document, so §4.2's degradation does not apply.

### 6.3 Selection

`capture-markdown` tries 6.1 first, falling back to 6.2 on desktop when: the
fetch is non-2xx, the content type is not HTML, or `wordCount` comes back under a
threshold (the SPA-shell signal). Explicit `--transport fetch|browser` overrides.

## 7. Phasing

| Phase | Content | Gate |
|---|---|---|
| 0 | `WebContentExtractor` service — the single Defuddle call site | Unit tests over saved HTML fixtures |
| 1 | Fetch transport + metadata frontmatter | Captures a static article end to end |
| 2 | Live-DOM transport via `executeJavaScript` | Matches or beats current output on a JS-heavy page |
| 3 | Auto-selection + `--transport` override | SPA falls back correctly |
| 4 | Quality bake-off vs the legacy route (§9), then delete it and its 3 helpers | No regression on the comparison set |
| 5 | Per-tool mobile gating for the fetch transport | Capture works on mobile |

## 8. Mobile / desktop split

Today `webTools` is registered desktop+Electron only, which is correct for
`open`, `capture-png`, `capture-pdf` and `links` (all need a browser). The fetch
transport needs none of that. Either split the fetch capability into a tool that
registers on both platforms, or move the platform check from agent registration
to per-tool guards. The latter is cleaner and matches how `analyze` is gated in
the Bases plan.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Quality regression vs Web Viewer's save, which may be tuned beyond stock Defuddle | Bake-off on ~10 real pages (article, docs, blog, SPA, paywalled, math-heavy) **before** deleting the legacy route |
| 0.x API churn | Pin the exact version; keep the call behind `WebContentExtractor` so a break touches one file |
| Bundle growth | Measured at +92 KB gzip (§5); re-measure `main.js` before and after and record the delta in the PR |
| `requestUrl` differs from browser fetch (headers, redirects, encodings) | Fixture tests over real captured responses; fall back to the browser transport on failure |
| Losing math conversion | Known, accepted (§5); revisit with `/full` behind a setting if it bites |

## 10. Open questions

1. Do we keep the legacy save-to-vault route behind a setting for one release, or
   delete it once the bake-off passes? (Lean: delete — two code paths for one
   capability is how `captureToMarkdown` got complicated in the first place.)
2. Should the extractor also back `ingest`, which has its own HTML handling?
   Possible consolidation, out of scope until the tool ships.
3. Does `requestUrl` need a user-agent override for sites that gate on it?

## 11. Implementation reuse map (DRY)

| Need | Reuse |
|---|---|
| HTTP fetch | Obsidian `requestUrl` (CLAUDE.md rule: never `fetch()`) |
| HTML → Markdown | Obsidian `htmlToMarkdown` (§5) |
| URL safety check | `assertSafeWebUrl` (`webViewer.ts:61`) |
| Unique output paths | `resolveUniqueMarkdownPath` (`webViewer.ts:187`) |
| Parent folder creation | `ensureParentFolderExists` (`webViewer.ts:155`) |
| Live page DOM | `getWebViewerContents` (`webViewer.ts:146`) |
| Lazy heavy import | `await import()` inside async execute, per CLAUDE.md mobile rule 2 |

## 12. Non-goals

- Rendering/screenshotting — `capture-png`/`capture-pdf` stay browser-bound.
- A crawler. One URL per call; link following is `web links` plus the caller's own loop.
- Bundling a second markdown converter (§5).
