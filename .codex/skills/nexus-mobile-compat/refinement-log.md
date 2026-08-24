# Refinement log

2026-08-21 | The mobile reachability gate correctly accepted Web Crypto,
TextEncoder, Obsidian/DataAdapter-backed receipt persistence, and the existing
dynamically reached package exception; no false result or stale instruction was
found. | No change. | `refinement-log.md` only.

2026-08-21 | The reachability checker correctly traced the PR 5 policy additions from `src/main.ts`, reported the current browser-safe startup package, and found no Node built-in regression. | No change. | `refinement-log.md`.

Append-only record of changes made by `protocols/self-refine.md`. Newest on top.

2026-08-21 | The terminal validator command named the removed `.claude/skills`
mirror even though the mobile skill now lives under `.codex/skills`. | Corrected
the validation target; the mobile reachability command itself remained current. |
`protocols/self-refine.md`, `refinement-log.md`.

<!-- YYYY-MM-DD | observation | change made | file(s) touched -->

2026-08-21 | The reachability checker correctly attributed the startup increase
from 399 to 402 to the three new local provider-SPI modules, while validation
identified historical references to an intentionally deleted checker as live
dependencies. | Kept the historical facts but described the deleted Python
checker as prose so validation no longer treats it as a dangling file. |
`refinement-log.md` only.

2026-08-21 | The reachability checker correctly reported the one-module local
increase, no package increase, and no reachable Node builtin; no false positive,
miss, or user correction was available. | No skill change. |
`refinement-log.md` only.

2026-08-15 | Obsidian's community scorecard failed 5.17.0 with "Build verification
failed while running the build script", and the captured output was our own
`[check-mobile-imports] no Python 3 interpreter found`. Their builder is a clean
container with Node and no Python, so #221's `build -> lint -> lint:mobile` chain
exited 1 before anything compiled — which also suppressed the malware, vulnerable-
dependency, obfuscation and network scans, since those only run on a build that
completed. #221's message claimed "the Node port so the build needs no Python",
but only the launcher was ported; the walker stayed Python and the launcher's own
header said so. The lesson is narrower than "prefer Node": **a gate wired into the
build may only depend on what the build already needs.** Python was a prerequisite
nobody had declared, and it held on every machine we tested on. | Ported the
349-line walker to Node as the single implementation in
`scripts/check-mobile-imports.mjs`, deleted the Python script, and repointed every
protocol at the Node command. Verified byte-identical output to the Python original
across all five modes (default, `--packages`, `--json`, `--trace` on- and off-path),
still exit 1 on an injected `node:fs` in `src/main.ts`, and clean under
`env -i PATH=<node only>`. | `scripts/check-mobile-imports.mjs` (repo), the
deleted Python checker, `SKILL.md`, all five `protocols/`,
`references/init-order.md`.

2026-08-15 | Vetted `node-llama-cpp@3.19.1` for a research-only local-model
architecture comparison. The published package is Node-only, has no browser
entry, and upstream explicitly forbids Electron renderer use; the existing
dependency-vetting and desktop-isolation protocols routed the investigation
correctly. | No skill change. | refinement-log.md only.

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
to check it (issue #221). | Split into protocols/references and added the
original Python reachability checker (since deleted), which walked the static
import graph from `src/main.ts` and failed on a reachable Node built-in. | whole
skill.
