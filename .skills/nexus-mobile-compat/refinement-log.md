# Refinement log

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-14 | The checker existed but nothing in the repo ran it, so the skill
told readers it was "the only guard" while a violation could still ship — an
unfinished artifact, not a gate. Also found that a Node built-in import in a
settings UI primitive was only an ESLint *warning* (`obsidianmd/no-nodejs-modules`
is warn), so it did not fail lint. | Wired the checker into `npm run lint`
(`lint:mobile`, via `scripts/check-mobile-imports.mjs`, a Python-3 launcher —
not a second implementation) and pointed `npm run build` at `npm run lint`;
added an erroring `@typescript-eslint/no-restricted-imports` blocklist for
`src/settings/components/**` (issue #221 acceptance). Proved red-then-green with
a temporary `import { EventEmitter } from 'events'` in
`src/core/PluginLifecycleManager.ts`. | SKILL.md,
protocols/verify-mobile-safety.md (skill); package.json, eslint.config.mjs,
scripts/check-mobile-imports.mjs (repo).

2026-08-14 | Restructured from a single prose document under the skill-crafter
improve-skill protocol. The reachability rule was stated as a hazard with no way
to check it (issue #221). | Split into protocols/references and added
`scripts/check_mobile_imports.py`, which walks the static import graph from
`src/main.ts` and fails on a reachable Node built-in. | whole skill.
