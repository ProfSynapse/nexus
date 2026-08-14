# Protocol: confine a vault path

Context: a path is about to reach `vault.*` or `adapter.*`. `normalizePath()`
collapses separators and **does not strip `..`** — on desktop a `..`-bearing path
resolves through Node's path join and escapes the vault entirely. Confinement is
therefore explicit, and it is a security boundary, not a tidiness rule.

## Mission
Make every caller-supplied path pass the one containment boundary before any
mutation, and make it obvious to the next reader that it did.

## Steps

1. **Classify the path's origin.** Untrusted means anything a caller, an LLM tool
   argument, a settings field or a file's contents supplied. Trusted means
   code-controlled: an event-store key, a cache filename, a migration internal.
   When unsure, treat it as untrusted — the trusted path never rejects, so
   guessing wrong in that direction removes the guard.

2. **Resolve through `src/core/vaultPath.ts` and nothing else.** It exports a
   branded `VaultPath` type constructible only through that module, so an
   unvalidated string cannot be substituted for a validated one.
   - Untrusted → `resolveVaultPath` (throws) or `tryResolveVaultPath` (returns a
     result). These REJECT traversal, absolute and home-expansion paths.
   - Trusted → `vaultPathFromTrusted`, which canonicalizes and never rejects.
   The module is mobile-safe: Obsidian's `normalizePath` only, no Node built-ins,
   so it is fine on the init path.

3. **Check which `resolveVaultPath` your editor imported.** A function with that
   exact name also exists in the Skills app's path helper, and it has the
   **opposite** semantics: it *folds* `..` segments away instead of rejecting
   them, as an input to a separate prefix-containment check. Importing the folding
   one where the rejecting one belongs silently weakens the boundary — no error,
   no test failure. Verify the import specifier resolves to `src/core/vaultPath`.

4. **Write through the `VaultOperations` facade.** Direct `vault.create/modify/
   rename/delete`, direct `adapter.write/mkdir/remove` and direct
   `fileManager.renameFile/trashFile` are rejected by `no-restricted-syntax`
   selectors in `eslint.config.mjs` outside the facade and its allowlist. If lint
   points you at the allowlist, route through the facade instead; add an allowlist
   entry only for a genuinely code-controlled internal path, with the reason.

5. **Do not hand-roll the traversal check.** The real one is segment-based:
   it splits on `/` and rejects a segment equal to `..`. `includes('..')` is
   wrong in both directions — it rejects legitimate filenames such as
   notes/a..b.md, which the module's own contract says MUST pass, and it invites
   the belief that a substring test is sufficient.

6. **Verify.**
   ```bash
   npm run lint          # the direct-mutation tripwire
   npm test              # the vaultPath unit lane
   ```
   A new test for a new path surface belongs in the lane `nexus-testing`
   prescribes, and it MUST include a rejection case — a confinement test that only
   asserts the happy path proves nothing.

## Guidelines
- Pattern: resolve at the boundary where the untrusted string arrives, then pass
  the branded `VaultPath` downward. Re-resolving deep in the stack means some
  caller reached that depth unresolved.
- Pattern: when you add a path-taking tool parameter, treat the parameter schema
  as documentation only. There is no validator behind it; the guard is this
  module.
- Anti-pattern: `normalizePath()` alone as validation. It is a formatter.
- Anti-pattern: assuming mobile is safe because it has no Node path join. The
  boundary is about what the write reaches, and the code is shared.

## Next
If the change also touched imports, run `verify-mobile-safety.md`. For storage
roots and persistence questions, hand off to `nexus-storage`.
