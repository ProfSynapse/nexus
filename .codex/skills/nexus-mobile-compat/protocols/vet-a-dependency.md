# Protocol: vet a dependency

Context: an npm package is about to be added or upgraded. Nexus ships one
`main.js` to phones, so a package decides two independent things — whether the
plugin still boots, and how large the download is. Neither is visible from the
README.

## Mission
Establish, from the published bytes, that the package is safe to load in the
Obsidian renderer on mobile, and know what it costs, before it enters
`package.json`.

## Steps

1. **Ask whether the package is needed at all.** Obsidian already provides
   cross-platform answers to the common reasons for reaching outward: `Events`
   instead of `EventEmitter`, `parseYaml`/`stringifyYaml` instead of a YAML
   package (`yaml` is a devDependency here and MUST NOT be imported from `src/`),
   `requestUrl` instead of an HTTP client, `normalizePath` for path shape. If one
   of these covers it, stop — this is the cheapest safe outcome.

2. **Read the published tarball, not the repository.** The repo may have a
   browser story the shipped files do not.
   ```bash
   npm pack <pkg>@<version> && tar xzf <pkg>-<version>.tgz
   grep -rlE "require\(.(node:)?(fs|path|http|stream|os|crypto|events|child_process)" package/
   ```

3. **Judge the hits by entry point.** Hits confined to a CLI, a `server` entry or
   a Node-only build that the browser entry never imports are fine — that is the
   same reachability argument this repo relies on internally. Hits in the entry
   your import resolves to are disqualifying. Check `package.json`'s `browser`,
   `exports` and `main` fields to see which entry a bundler will actually pick,
   and prefer an explicit browser or `legacy` entry when the package offers one.

4. **Measure the bundle cost.**
   ```bash
   npx esbuild entry.mjs --bundle --minify --format=esm --platform=browser --outfile=out.js
   ```
   Obsidian plugins ship a single `main.js`, so a lazy `await import()` still
   lands in that file. **Lazy loading protects init, not size.** They are two
   problems and a package may force you to solve both.

5. **Decide the import form** with `import-without-crashing.md`. Default to
   `await import()` inside the async function that needs it, even for a package
   that passed step 3 — it keeps init cheap and keeps the blast radius of a
   future upstream change small.

6. **Verify the graph after wiring it up.**
   ```bash
   node scripts/check-mobile-imports.mjs . --packages
   ```
   Every package the checker lists is loaded during mobile init. If your new
   package appears there, you either meant it (and it passed step 3) or you
   static-imported something you meant to defer.

7. **Record why.** Put the entry-point reasoning in a comment at the import site.
   The next person sees a bare package name and no way to know it was checked.

## Guidelines
- Pattern: prefer a package that publishes an explicit browser or `legacy` entry.
  The maintainers have then already drawn the line you are trying to find.
- Pattern: re-vet on upgrade. A minor release can add a Node require to a browser
  entry, and nothing in this repo will notice.
- Anti-pattern: trusting "works in the browser" from the README or from the fact
  that the desktop app loaded it. Electron has Node; phones do not.
- Anti-pattern: adding a dependency to avoid ten lines. The download is paid by
  every user on every update.

## Next
Import it per `import-without-crashing.md`, then prove the change with
`verify-mobile-safety.md`.
