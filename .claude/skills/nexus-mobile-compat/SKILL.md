---
name: nexus-mobile-compat
description: How to keep Nexus loading on mobile and compliant with Obsidian plugin store rules — vetting a dependency, importing safely, confining vault paths, and verifying none of it regressed. Use before adding any npm package or Node import, when writing to vault paths, when a feature is desktop-only, or when the plugin fails to load on a phone.
---

# Mobile Safety & Plugin Rules

Full guidelines: `docs/obsidian-plugin-guidelines.md`. This skill is the part that
bites.

## The rule, and why a guard cannot save you

`isDesktopOnly: false` — this plugin runs on mobile, where Node.js built-ins
(`fs`, `path`, `http`, `crypto`, `events`, `stream`, `net`, `os`, `url`, `process`,
`buffer`) do not exist.

**Top-level imports execute during module init, before any `Platform.isDesktop`
check can run.** A platform guard below a top-level import is decoration — the
import already crashed the plugin. This is why the rule is about *where* you import,
not whether you check the platform.

| Pattern | Result on mobile |
|---|---|
| `import x from 'node-dependent-pkg'` (top level) | **Crashes plugin at init** |
| `import { EventEmitter } from 'events'` (top level) | **Crashes plugin at init** |
| `const x = await import('node-dependent-pkg')` (inside async fn) | Safe — loads when called |
| `const fs = desktopRequire<typeof import('node:fs')>('node:fs')` (inside fn) | Safe — lazy |

So: never top-level import a Node built-in — use `desktopRequire()` from
`src/utils/desktopRequire.ts`. Never top-level import an npm package with Node
transitive deps — `await import()` it inside an async function. Use Obsidian's
`Events` class instead of `EventEmitter`. For YAML use Obsidian's
`parseYaml`/`stringifyYaml`, which are cross-platform and what the codebase uses
throughout.

## Before adding a dependency

Check the published package, not the README:

```bash
npm pack <pkg>@<version> && tar xzf <pkg>-<version>.tgz
grep -rlE "require\(['\"](node:)?(fs|path|http|stream|os|crypto)['\"]\)" package/dist
```

If the hits are confined to a CLI or Node-specific entry that the browser entry
never imports, the browser entry is safe to bundle — still import it lazily.

Measure the cost while you are there:

```bash
npx esbuild entry.mjs --bundle --minify --format=esm --platform=browser --outfile=out.js
```

Obsidian plugins ship a single `main.js`, so a lazy `import()` still lands in the
bundle. **Lazy loading protects mobile init; it does not reduce bundle size.** Those
are two separate problems and you may need to solve both.

## Verify mobile safety

The check that matters is **reachability**, not grep. A top-level Node import is
harmless in a module nothing loads at startup, and fatal in one that does.

```bash
# top-level Node built-in imports anywhere in src/
grep -rnE "^import .*(from )?['\"](node:)?(fs|path|http|stream|os|crypto|events|net|buffer|child_process)['\"]" src/
```

Two things that will show up and are **correct**: `connector.ts` and `cli/*.ts`
import Node built-ins statically, but they are separate Node-targeted builds that
never enter `main.js`; and some generated asset files contain `require("net")`-style
text inside string constants, which never executes.

The real hazard is subtler. Some modules do top-level import Node-dependent packages
and are safe **only because they are not statically reachable from `src/main.ts`**.
That safety is a property of the current import graph, not of the code: one
innocuous top-level import from a startup-reachable file pulls them into init and
breaks launch on mobile, with a diff that looks unrelated and nothing in CI to catch
it. If you are adding an import to anything on the startup path, trace what it drags
in. A reachability lint is tracked in
[#221](https://github.com/ProfSynapse/nexus/issues/221).

**Emulation does not prove mobile safety.** `obsidian dev:mobile on` emulates
`Platform.isMobile`, touch and layout, but does not remove Node built-ins from
Electron — `require('fs')` still resolves, so this crash class will not reproduce.
Use it for UI and platform-branch coverage only, and never read a green
`dev:mobile` run as "mobile-safe".

## Confining vault paths

**`normalizePath()` does not strip `..`.** It collapses separators only, so a
`..`-bearing path handed to `vault.create()` or `adapter.write()` resolves through
Node's path join on desktop and escapes the vault. Confinement is therefore
explicit.

The vault-wide boundary is `src/core/vaultPath.ts`: a branded `VaultPath` type
constructible only through that module. Use `resolveVaultPath` /
`tryResolveVaultPath` for **untrusted, caller-supplied** paths — they reject
traversal, absolute and home-expansion paths — and `vaultPathFromTrusted` for
code-controlled paths, which canonicalizes and never rejects. The traversal check is
segment-based rather than `includes('..')`, so a legitimate `notes/a..b.md` still
passes. It is mobile-safe: no Node built-ins.

⚠️ **`resolveVaultPath` exists in two modules with opposite semantics.** The
`src/core/vaultPath.ts` one *rejects* traversal; the Skills-app one in
`src/agents/apps/skills/services/skillPaths.ts` *folds* it. Check your import — the
wrong one silently weakens a security boundary rather than failing.

## Plugin store rules

- All styles in `styles.css`, never inline
- `innerHTML` forbidden with dynamic content — use `createEl()` / `.textContent`.
  Only clearing (`el.innerHTML = ''`) and reading already-escaped content are
  sanctioned
- `registerDomEvent` for DOM events, never `addEventListener` — it leaks. The
  exception is a target Obsidian's `Component` API cannot bind (`Worker`,
  `AbortSignal`, `visualViewport`); where a renderer has no `Component`, the
  codebase falls back deliberately
- `requestUrl()` not `fetch()`; `normalizePath()` for paths
- `vault.adapter` is fine for direct storage-path access — normalize, and resolve
  roots from settings rather than hardcoding
- Deletion goes through `app.fileManager.trashFile()`

## pdfjs-dist in Obsidian/Electron

PDF.js treats the Electron renderer as a browser and expects a configured
`workerSrc`. The worker **cannot** be bundled or shipped as a release asset —
Obsidian community releases may only ship `main.js` / `manifest.json` /
`styles.css` — so the loader points `workerSrc` at a CDN copy pinned to the
installed version and memoizes the module promise.

Always go through `loadPdfJs()` in
`src/agents/ingestManager/tools/services/PdfJsLoader.ts`, and always the
`legacy/build/pdf.mjs` entry, so `workerSrc` is configured exactly once. Do not
import `pdfjs-dist` directly — the main entry fails in Electron without a worker URL.

## Line endings

`.gitattributes` sets `* text=auto eol=lf` plus explicit declarations per extension.
CRLF in the tree is a local-editor bug — fix the editor, don't chase it with tool
normalization. If hundreds of files show modified with a tiny `--ignore-cr-at-eol`
delta, someone's editor wrote CRLF: `git add --renormalize .` on that subset, and
don't let it land.

## Gotchas

**"The plugin won't load on my phone and the diff looks unrelated."** Something on
the startup path gained an import that transitively reaches a Node-dependent module.
Trace reachability from `src/main.ts`, not just your own file.

**"I added a `Platform.isDesktop` guard and it still crashes."** The guard runs after
module init. Move the import inside a function.

**"`dev:mobile` was green."** It cannot catch this class. See above.

**"My path validation passed but the write escaped the vault."** You used the
folding `resolveVaultPath`, not the rejecting one, or relied on `normalizePath()`.

**"I lazy-imported the package and `main.js` grew anyway."** Expected — one bundle.
Lazy import is about init safety, not size.
