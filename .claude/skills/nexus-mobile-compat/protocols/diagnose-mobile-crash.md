# Protocol: diagnose a mobile-only failure

Context: the plugin loads on desktop and fails on a phone, or a mobile user
reports something the desktop build never shows. The diff usually looks
unrelated to mobile, because the mechanism is the import graph rather than the
edited lines.

## Mission
Identify the mechanism from the symptom and reach the fix without a device round
trip per hypothesis.

## Steps

1. **Establish whether it is an init crash or a runtime failure.** An init crash
   means the plugin does not appear at all — no commands, no view, no settings
   tab. A runtime failure means Nexus loaded and one feature misbehaves. They
   have disjoint causes; do not mix the two investigations.

2. **For an init crash, run the checker first.**
   ```bash
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py .
   ```
   If it exits non-zero, the printed chain is the answer. Fix per
   `import-without-crashing.md` and stop.

3. **If the checker is clean, suspect a transitive package.** Lint and the
   checker both see Node built-ins; neither sees a package that requires one
   internally.
   ```bash
   python3 .claude/skills/nexus-mobile-compat/scripts/check_mobile_imports.py . --packages
   ```
   Take each package on that list through step 2 of `vet-a-dependency.md` —
   `npm pack`, grep the published files, check which entry the bundler resolves.
   Start with anything added or upgraded in the failing range.

4. **Bisect by reachability, not by commit, when the range is large.** For each
   suspect module, `--trace` it. A module that became reachable in the failing
   range is the candidate, and the chain names the exact import to break.

5. **Match the symptom against these mechanisms before theorizing further.**

   | Symptom | Mechanism |
   |---|---|
   | Plugin absent on mobile, present on desktop, unrelated-looking diff | something on the startup path gained an import that transitively reaches Node |
   | Added a `Platform.isDesktop` guard, still crashes | the guard is below a top-level import; module init already ran |
   | `dev:mobile` was green | Electron still has Node; this class cannot reproduce there |
   | Path validation "passed" but a write escaped the vault | the folding `resolveVaultPath` was imported instead of the rejecting one, or `normalizePath()` was treated as validation |
   | Lazy-imported a package and `main.js` grew anyway | expected: one bundle. Lazy import is init safety, not size |
   | PDF feature fails only in the app | PDF.js imported directly instead of through `loadPdfJs()`, so `workerSrc` was never configured |
   | Feature works on desktop, silently does nothing on mobile | a desktop-only branch degrading to a no-op instead of an honest disabled state |

6. **Reproduce on a device before and after the fix.** For an init crash the
   signal is binary and takes one launch. `nexus-testing` owns the in-app loop
   and log reading; use it for anything that needs the plugin driven rather than
   merely loaded.

7. **Leave the guard behind.** A crash this protocol found MUST end with either a
   checker run that now fails on the old code, or a written note at the import
   site explaining the reachability fact that keeps it safe. Otherwise the same
   defect returns under a different filename.

## Guidelines
- Pattern: read the chain the checker prints from the leaf upward. The nearest
  link to the leaf is usually the cheapest one to break.
- Pattern: when the report comes from a user, ask which platform and whether the
  plugin appears in the list at all. That single answer splits step 1.
- Anti-pattern: bisecting on a device. Each round is minutes; the checker answers
  the same question in seconds for the whole range.
- Anti-pattern: adding a `Platform` guard as the fix for an init crash. Move the
  import; the guard is not the mechanism.

## Next
Apply the fix through `import-without-crashing.md`, then gate it with
`verify-mobile-safety.md`.
