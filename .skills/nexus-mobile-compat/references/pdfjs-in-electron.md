# pdfjs-dist inside Obsidian/Electron

The worked example of a dependency whose constraints are shaped by the store
rules rather than by mobile alone. Read this before touching PDF ingestion or
adding any other worker-backed library.

## The bind

PDF.js treats the Electron renderer as a browser and refuses to work without a
configured `workerSrc`. The obvious fixes are both closed:

- **Bundle the worker into `main.js`** — it is a separate script the library
  loads by URL at runtime, not a module it imports.
- **Ship the worker as a release asset** — Obsidian community releases may carry
  only `main.js`, `manifest.json` and `styles.css`.

So the loader points `workerSrc` at a CDN copy pinned to the version PDF.js
itself reports, and memoizes the module promise so the configuration happens
exactly once.

## The rule

Always load PDF.js through `loadPdfJs()` in
`src/agents/ingestManager/tools/services/PdfJsLoader.ts`, and always through the
`legacy/build/pdf.mjs` entry.

Never `import 'pdfjs-dist'` directly. The main entry fails in Electron without a
worker URL, and a second import path would mean a second, unconfigured module
instance. The loader's `await import()` also keeps the library off the init path
— see `init-order.md`.

## The generalization

When a library wants a sibling file at runtime — a worker, a wasm binary, an
asset — the three-file release limit decides the design before mobile does. The
options that remain are: a pinned remote URL, an inlined data URL, or dropping
the feature. Pick deliberately and write down which, because the next person will
otherwise "fix" it by adding a release asset that the store rejects.
