# Why a platform guard cannot save a top-level import

Background for every protocol in this skill. Read it once; it explains why the
rules are about *where* you import rather than whether you checked the platform.

## Module init runs before your code does

A static `import` is hoisted and executed when the module is initialized. That
happens while `main.js` is being evaluated at plugin load — before any function
body runs, therefore before any `Platform.isDesktop` check inside one.

```ts
import { EventEmitter } from 'events';   // ← already threw on mobile
if (Platform.isDesktop) { /* never reached */ }
```

The guard below is decoration. Nothing observable distinguishes it from a correct
guard on desktop, which is why this ships.

Two forms are safe because they defer the load past init:

| Form | When it loads |
|---|---|
| `desktopRequire<typeof import('node:fs')>('node:fs')` inside a function | at call time, desktop only |
| `await import('some-pkg')` inside an async function | at call time, both platforms |

`desktopRequire` lives at `src/utils/desktopRequire.ts`. It goes through
`window.activeWindow.require`, which does not exist on mobile, so it throws a
readable error instead of taking the plugin down — but only if it is called from
inside a function.

## Reachability, not grep

The same top-level import is fatal in a module the startup path loads and inert
in one it does not. So the property that keeps the tree safe is a shape of the
import graph, and any new import anywhere can change it.

That is why `scripts/check-mobile-imports.mjs` walks the graph from `src/main.ts`
instead of grepping. It follows static imports only: `await import()` is a
deliberate non-edge, because deferring the load is exactly the fix.

Two things a naive grep reports that are **correct** and the checker ignores by
construction:

- `connector.ts` and the files under `cli/` import Node built-ins statically.
  They are separate Node-targeted builds with their own tsconfigs, never enter
  `main.js`, and are listed in the ESLint ignores for that reason.
- Generated asset modules embed CLI source as string constants, so
  `require("...")` text appears in them without ever executing. They are
  generated — regenerate them, never hand-edit.

The subtler case is real and current: modules that top-level import Node-dependent
packages and are safe **only** because nothing on the startup path imports them.
`--trace` tells you which side of that line a module is on. A module that is not
reachable today becomes reachable the moment one reachable file imports it, and
the resulting diff looks like an ordinary refactor.

## Emulation cannot reproduce this

`obsidian dev:mobile on` emulates `Platform.isMobile`, touch input and phone
layout inside Electron. Electron still has Node, so `require('fs')` resolves and
the crash does not happen. Use it for UI and platform-branch coverage. A green
`dev:mobile` run is not evidence of mobile safety; the checker and a real device
are. `nexus-testing` owns the in-app loop that drives it.

## What ESLint does and does not cover

`eslint-plugin-obsidianmd` flags Node built-in imports in `.ts` sources (the rule
is switched off only for the `.js`/`.mjs` build scripts, which legitimately run
under Node). So a *direct* built-in import is usually caught by `npm run lint`.

What lint cannot see is transitive: an npm package that itself requires a Node
built-in. That is a fact about published bytes, not about this repo, which is why
`protocols/vet-a-dependency.md` inspects the package rather than trusting a rule.
