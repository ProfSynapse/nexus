---
name: nexus-mobile-compat
description: Obsidian plugin store rules and mobile compatibility for Nexus — which imports crash on mobile, desktopRequire, path confinement, DOM and styling constraints. Use before adding any npm dependency or Node import, when touching plugin lifecycle or DOM code, when writing to vault paths, or when a feature is desktop-only.
---

# Nexus Plugin Rules & Mobile Compatibility

Full guidelines: `docs/obsidian-plugin-guidelines.md`. This skill is the part that
bites in practice.

## Non-negotiable plugin rules

- All styles in `styles.css` — never inline
- `innerHTML` forbidden with dynamic content — use `createEl()` / `.textContent`
- `registerDomEvent` for all DOM events, never `addEventListener` — it leaks
- `requestUrl()` not `fetch()` for HTTP; `normalizePath()` for paths
- `vault.adapter` is acceptable for direct storage-path access; normalize paths and
  resolve storage roots from settings rather than hardcoding `.nexus` or `Nexus`
- **`normalizePath()` does NOT strip `..`.** Path confinement needs an explicit
  `assertInside`-style guard at every write/copy/remove boundary. See
  `src/agents/apps/skills/services/skillPaths.ts` for the pattern
  (`resolveVaultPath` / `assertInside` / `isSafePathSegment`)
- Plugin store compliance: `isDesktopOnly: false` is correct. `VaultOperations`
  uses `app.fileManager.trashFile()` (constructor takes `App` first)

## Mobile compatibility — the critical part

**`isDesktopOnly: false`** — this plugin runs on mobile, where Node.js built-ins
(`fs`, `path`, `http`, `crypto`, `events`, `stream`, `net`, `os`, `url`, `process`,
`buffer`) **do not exist**.

**Top-level imports execute during module init, BEFORE any `Platform.isDesktop`
guard can run.** A guard below a top-level import is decoration.

| Pattern | Result on mobile |
|---|---|
| `import mammoth from 'mammoth'` (top level) | **Crashes plugin** — depends on `stream`, `fs` |
| `import { EventEmitter } from 'events'` (top level) | **Crashes plugin** — null on mobile |
| `const mammoth = await import('mammoth')` (inside async fn) | **Safe** — loads only when called |
| `const fs = desktopRequire<typeof import('node:fs')>('node:fs')` (inside fn) | **Safe** — lazy |

**Rules for new code:**

1. **Never** top-level import Node built-ins — use `desktopRequire()` from
   `src/utils/desktopRequire.ts`
2. **Never** top-level import npm packages with Node transitive deps — use dynamic
   `await import()` inside an async function
3. **Replace** `EventEmitter` with Obsidian's `Events` class (cross-platform)
4. **Desktop-only features** (ingestion, composer, OAuth, CLI, MCP transports, data
   analysis, web tools): ensure every Node-dependent import is lazy

**Known desktop-only npm packages:** mammoth, jszip, xlsx, yaml — all have Node
transitive deps. For YAML specifically, use Obsidian's `parseYaml`/`stringifyYaml`
instead; they are cross-platform and already available.

### Vetting a new dependency

Before adding one, check whether its browser entry pulls Node built-ins. Do it
against the published package, not the README:

```bash
npm pack <pkg>@<version> && tar xzf <pkg>-<version>.tgz
grep -rlE "require\(['\"](node:)?(fs|path|http|stream|os|crypto)['\"]\)" package/dist
```

If the hits are confined to a CLI or Node-specific entry that the browser entry
never imports, the browser entry is safe to bundle — still import it lazily per
rule 2. Bundle cost is worth measuring at the same time:

```bash
npx esbuild entry.mjs --bundle --minify --format=esm --platform=browser --outfile=out.js
```

Obsidian plugins ship a single `main.js`, so a lazy `import()` still lands in the
bundle — lazy loading protects mobile *init*, it does not reduce bundle size.

## Emulation does not prove mobile safety

`obsidian dev:mobile on` emulates `Platform.isMobile`, touch and layout. It does
**not** remove Node built-ins from Electron, so `require('fs')` still resolves
there and the crash class above will **not** reproduce. Use it for UI and
platform-branch coverage only.

## pdfjs-dist in Obsidian/Electron

PDF.js 5 expects a configured `workerSrc` in the Electron renderer. Use the legacy
build with the shared loader that seeds `globalThis.pdfjsWorker`:

```typescript
// src/agents/ingestManager/tools/services/PdfJsLoader.ts
const [pdfjsLib, pdfjsWorker] = await Promise.all([
  import('pdfjs-dist/legacy/build/pdf.mjs'),
  import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
]);
if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = pdfjsWorker;
```

Use `loadPdfJs()` from `PdfJsLoader.ts` in both `PdfTextExtractor.ts` and
`PdfPageRenderer.ts`. Do NOT `import('pdfjs-dist')` directly — the main entry fails
in Electron without a worker URL.

## Line endings

`.gitattributes` declares LF canonical across `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`/
`.json`/`.md`/`.css`/`.html`/`.yml`/`.sh`. CRLF in the tree is a local-editor bug —
fix the editor, don't chase it with tool normalization. If hundreds of files show
modified with a tiny `--ignore-cr-at-eol` delta, someone's editor wrote CRLF:
`git add --renormalize .` on that subset, and don't let it land.
