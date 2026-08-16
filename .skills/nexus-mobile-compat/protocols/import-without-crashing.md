# Protocol: import without crashing init

Context: code needs a Node built-in, a heavy or Node-dependent package, or a
feature that only makes sense on desktop. `references/init-order.md` explains why
a `Platform.isDesktop` check placed below an import does nothing; this protocol is
what to write instead.

## Mission
Get the capability wired in without putting anything on the module-init path that
mobile cannot execute.

## Steps

1. **Classify what you need.**
   - A Node built-in (`fs`, `path`, `crypto`, `child_process`, …) → step 2.
   - An npm package → it must have cleared `vet-a-dependency.md` first → step 3.
   - A capability Obsidian already provides cross-platform → use that and stop.
     `Events` covers `EventEmitter`; `parseYaml`/`stringifyYaml` cover YAML;
     `requestUrl` covers HTTP; `normalizePath` covers path shape.

2. **Node built-in: `desktopRequire`, called inside a function.**
   ```ts
   import { desktopRequire } from '../utils/desktopRequire'; // safe: no Node deps

   async function readIt(p: string) {
     const fs = desktopRequire<typeof import('node:fs/promises')>('node:fs/promises');
     return fs.readFile(p, 'utf-8');
   }
   ```
   The `typeof import(...)` in the type argument is a type position and is erased,
   so it costs nothing at runtime. The call MUST sit inside the function body —
   hoisting it to a module-level `const` re-creates the crash exactly.

3. **npm package: `await import()` inside the async function that uses it.**
   ```ts
   const { thing } = await import('some-pkg');
   ```
   Memoize the promise in a module-level variable if the call site is hot, the way
   the PDF.js loader does (`references/pdfjs-in-electron.md`). Do not memoize by
   moving the import to the top.

4. **Gate the feature, not just the import.** Put `Platform.isDesktop` (or the
   repo's capability predicate for the feature) at the *call site*, and make the
   mobile branch degrade honestly — a disabled control with an explanation, not a
   silent no-op and not a thrown error the user sees as a crash.

5. **Keep the desktop-only module off the startup path.** If a whole module is
   desktop-only, do not let a startup-reachable file import it statically for a
   type, a constant or a registration side effect. Import types with
   `import type`, which is erased, and reach the module itself through
   `await import()`.

6. **Prove it.**
   ```bash
   node scripts/check-mobile-imports.mjs .
   node scripts/check-mobile-imports.mjs . --trace <your/file.ts>
   ```
   The first exits non-zero if any Node built-in became reachable. The second
   tells you whether the module you just edited is on the startup path at all —
   check it before *and* after, because a module moving onto the path is the
   change that turns a latent import into a crash.

## Guidelines
- Pattern: the safest import is the one you did not add. Check Obsidian's API
  first, every time.
- Pattern: when a module is unreachable from init today, say so in a comment at
  the top-level import that depends on that fact. It is invisible otherwise, and
  the next refactor deletes the safety without noticing.
- Anti-pattern: `const fs = desktopRequire('node:fs')` at module scope. It is
  lazy in name only — the call runs at init.
- Anti-pattern: a `try/catch` around a top-level import "to be safe". The failure
  is in module evaluation; nothing local catches it.

## Next
Run `verify-mobile-safety.md` before you call the change done.
