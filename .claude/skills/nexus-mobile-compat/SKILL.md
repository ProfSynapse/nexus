---
name: nexus-mobile-compat
description: Obsidian plugin store rules and mobile compatibility for Nexus — which imports crash on mobile, desktopRequire, path confinement, DOM and styling constraints. Use before adding any npm dependency or Node import, when touching plugin lifecycle or DOM code, when writing to vault paths, or when a feature is desktop-only.
---

# Nexus Plugin Rules & Mobile Compatibility

Full guidelines: `docs/obsidian-plugin-guidelines.md`. This skill is the part that
bites in practice.

## Non-negotiable plugin rules

- All styles in `styles.css` — never inline
- `innerHTML` forbidden with dynamic content — use `createEl()` / `.textContent`.
  Only two forms are sanctioned: `el.innerHTML = ''` to clear, and *reading*
  already-escaped content (`docs/obsidian-plugin-guidelines.md` §Security)
- `registerDomEvent` for all DOM events, never `addEventListener` — it leaks. The
  exception is a target Obsidian's `Component` API cannot bind (`Worker`,
  `AbortSignal`, `window.visualViewport`); where a renderer has no `Component`,
  the codebase uses a `component ? registerDomEvent : addEventListener` fallback
- `requestUrl()` not `fetch()` for HTTP; `normalizePath()` for paths
- `vault.adapter` is acceptable for direct storage-path access; normalize paths and
  resolve storage roots from settings rather than hardcoding `.nexus` or `Nexus`
- **`normalizePath()` does NOT strip `..`.** It collapses separators only, so a
  `..`-bearing path handed to `vault.create()` / `adapter.write()` resolves through
  Node's `path.join` on desktop and escapes the vault. Confinement is therefore
  explicit, in two layers:
  - `src/core/vaultPath.ts` — the vault-wide boundary. A branded `VaultPath` type
    that is *only* constructible through this module: `resolveVaultPath` /
    `tryResolveVaultPath` for untrusted caller-supplied paths (they REJECT
    traversal, absolute and home-expansion paths), `vaultPathFromTrusted` for
    code-controlled paths (canonicalizes, never rejects). The traversal check is
    segment-based, not `includes('..')`, so `notes/a..b.md` still passes. Mobile-safe
    — no Node built-ins, only `normalizePath`.
  - `src/agents/apps/skills/services/skillPaths.ts` — the Skills-app layer:
    `resolveVaultPath` / `assertInside` / `isSafePathSegment` (+ `SkillPathError`),
    applied at every write/copy/remove boundary in the Skills app. ⚠️ Its
    `resolveVaultPath` is a *different* function from the `core/vaultPath.ts` one
    of the same name — it folds `..` rather than rejecting it. Check your import.
- Plugin store compliance: `isDesktopOnly: false` is correct. `VaultOperations`
  (`src/core/VaultOperations.ts`) uses `app.fileManager.trashFile()` and its
  constructor takes `App` first

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
4. **Node-dependent features** (ingestion, OAuth, CLI bridge, MCP transports, data
   analysis, web tools): ensure every Node-dependent import is lazy. Only `data`
   (data analysis) is gated out of the app registry on mobile
   (`AppManager.getBuiltInAppRegistry`); `web-tools` registers everywhere but each
   tool returns "desktop-only" behind an `isDesktop() && isElectron()` runtime
   guard. Composer is *not* desktop-only — it is cross-platform and ships no
   Node-dependent import.

**Desktop-only npm packages in this repo:** `mammoth` and `jszip` — both runtime
dependencies, both correctly loaded via `await import()` inside an async function
(`DocxExtractionService.ts:29`, `PptxExtractionService.ts:36`). JSZip also has a
static `import type JSZip` — type-only, erased at compile, harmless.

For YAML, use Obsidian's `parseYaml`/`stringifyYaml`; they are cross-platform and
already available, and are what the codebase uses throughout. The `yaml` npm
package is a devDependency only and is imported nowhere in `src/`. `xlsx` is not a
dependency of this project at all.

**Current baseline:** `src/` has *zero* top-level Node built-in imports. Every
runtime Node access goes through `desktopRequire()` inside a function body.
`connector.ts` and `cli/*.ts` do import Node built-ins statically — that is correct;
they are separate Node-targeted builds (`tsconfig.connector.json`,
`scripts/build-cli.mjs`) and never enter `main.js`. `src/utils/connectorContent.ts`
and `src/utils/cliAssets.ts` contain `require("net")`-style text, but only inside
generated template-literal string constants — nothing executes.

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
platform-branch coverage only — never read a green `dev:mobile` run as
"mobile-safe". See `docs/plans/obsidian-cli-verification-plan.md` §6.

## pdfjs-dist in Obsidian/Electron

PDF.js 5 treats the Electron renderer as a browser and expects a configured
`workerSrc`. The worker cannot be bundled or shipped as a release asset — Obsidian
community releases may only ship `main.js` / `manifest.json` / `styles.css` — so the
loader points `workerSrc` at a CDN copy pinned to the installed version, and
memoizes the module promise:

```typescript
// src/agents/ingestManager/tools/services/PdfJsLoader.ts
async function initializePdfJs(): Promise<PdfJsModule> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/legacy/build/pdf.worker.mjs`;
  }

  return pdfjsLib;
}
```

Use `loadPdfJs()` from `PdfJsLoader.ts` in both `PdfTextExtractor.ts` and
`PdfPageRenderer.ts` — both already do. Always the `legacy/build/pdf.mjs` entry, and
always via the shared loader, so `workerSrc` is configured exactly once.

## Line endings

`.gitattributes` sets `* text=auto eol=lf` and then declares LF explicitly across
`.ts`/`.tsx`/`.js`/`.mjs`/`.cjs`/`.jsx`/`.json`/`.yml`/`.yaml`/`.toml`/`.xml`/
`.md`/`.txt`/`.html`/`.css`/`.scss`/`.svg`/`.sh`/`.ps1`/`.bat`, with `binary`
markers for images and `.pdf`. CRLF in the tree is a local-editor bug —
fix the editor, don't chase it with tool normalization. If hundreds of files show
modified with a tiny `--ignore-cr-at-eol` delta, someone's editor wrote CRLF:
`git add --renormalize .` on that subset, and don't let it land.
