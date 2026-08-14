# Obsidian plugin-store rules as they apply to Nexus

The store scanner and the release bot reject on these. Full guidance lives in
docs/obsidian-plugin-guidelines.md; this is the subset that has actually caused
churn here, plus where each one is already enforced so you know what a green
`npm run lint` does and does not prove.

## Enforced by `npm run lint`

`npm run build` runs lint first, and the ESLint config is deliberately tuned to
**bot parity** — where the upstream recommended config warns but the release bot
treats a rule as required, the config raises it to error. Do not lower one to get
a build through; the bot will reject the release instead.

The config also forbids inline `eslint-disable` for the bot-mirrored rules,
because the bot rejects those too. Exceptions are expressed as file-level config
entries (an allowlist block in `eslint.config.mjs`), which makes every exception
reviewable in one place. Read the config's own comments before adding one.

Rules in this category include: Node built-in imports in `.ts` sources, deletion
routed through `app.fileManager.trashFile()` rather than a raw vault delete, and
the direct-mutation tripwire below.

## The direct-mutation tripwire

`no-restricted-syntax` selectors in `eslint.config.mjs` reject direct
`vault.create/modify/rename/delete/...`, direct `adapter.write/mkdir/remove/...`
and direct `fileManager.renameFile/trashFile` outside the `VaultOperations`
facade. A new file that writes directly fails lint until it either routes through
the facade or is added to the allowlist block with a reason.

This is the enforcement arm of `protocols/confine-a-vault-path.md`. Route
through the facade; do not reach for the allowlist first.

## Not enforced — you have to hold these yourself

- **Styles belong in `styles.css`.** Never inline styles. Add a class.
- **No `innerHTML` with dynamic content.** Build DOM with `createEl()` and set
  text through `.textContent`. Clearing (`el.innerHTML = ''`) and reading
  already-escaped content are the sanctioned uses.
- **`registerDomEvent`, not `addEventListener`.** A raw listener leaks because
  nothing unregisters it. The codebase's pattern is a small
  `safeRegisterDomEvent` helper that calls `component.registerDomEvent` when a
  `Component` is available and falls back to a plain listener only where there is
  no `Component` to own the lifetime, or where the target is one the `Component`
  API cannot bind (`Worker`, `AbortSignal`, `visualViewport`). Copy that helper's
  shape rather than inventing a new fallback.
- **`requestUrl()`, not `fetch()`.** `fetch` is subject to CORS in the renderer.
- **`normalizePath()` on every path** — and see
  `protocols/confine-a-vault-path.md`, because it does not do what its name
  suggests about `..`.
- **Never hardcode a storage root.** Resolve it from settings. `nexus-storage`
  owns that resolution.
- **Releases may ship only `main.js`, `manifest.json` and `styles.css`.** Any
  design that needs a fourth file — a worker bundle, a wasm blob — needs another
  answer. See `references/pdfjs-in-electron.md` for the worked example.

## Line endings

`.gitattributes` declares `* text=auto eol=lf` plus explicit per-extension
declarations. If a huge number of files show as modified with an empty
`--ignore-cr-at-eol` diff, an editor wrote CRLF: renormalize that subset with
`git add --renormalize` and fix the editor. Do not chase it with runtime path or
content normalization, and do not let it land — it buries real diffs.
