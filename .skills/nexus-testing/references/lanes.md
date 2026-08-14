# Lanes: where a test goes, and how to find what exists

No inventory here on purpose. Directory listings and env-var tables rot within a
release and then actively mislead. What follows is the *shape* of the lanes and
the commands that produce current truth.

## Find what exists

```bash
ls tests/                                     # every lane directory
ls tests/debug/ tests/eval/ tests/manual/     # the gated + human lanes
grep -rhoE 'process\.env\.[A-Z_]+' tests/debug/ tests/eval/ | sort -u
```

## Three rungs of fidelity

Pick the lowest rung that can still catch the defect you are worried about. The
rung is chosen by `mock-honesty.md`'s question, not by convenience.

**1. Mocked Jest** — `tests/unit/`, `tests/integration/`, `tests/agents/`,
`tests/core/`, `tests/services/`, `tests/perf/`. Fast, and the default. `obsidian`
resolves to `tests/mocks/obsidian/` via `moduleNameMapper` in jest.config.js, and
`@/` resolves to `src/`. `tests/setup.ts` supplies the globals Obsidian injects
(`createEl`, `createDiv`, and friends) because the node test environment has no
DOM. Everything on this rung is measured against hand-written stand-ins.

**2. Headless real-agent stack** — `tests/eval/headless/`. The middle rung most
people miss. `createHeadlessAgentStack` initialises the *real* ContentManager,
StorageManager, CanvasManager, SearchManager (vector off) and ToolManager
against a real filesystem directory, and hands back the production
`getTools`/`useTools` pair. `TestVaultManager` resets, seeds, snapshots and
restores that directory so scenarios stay isolated. When a mocked test would
only prove your fake agrees with itself, this rung gives you real agent code
without a running Obsidian. `tests/unit/ToolManagerCliSyntax.test.ts` uses it.

**3. Live** — `tests/debug/` drives a running vault through the `nexus` CLI;
`protocols/live-loop.md` drives the plugin inside Obsidian itself. Only what
cannot be observed below earns a place here: lifecycle, rendering, cold-cache
and hydration ordering. Gated, never a CI dependency.

`tests/manual/*.md` is a fourth thing rather than a rung: written scripts for
what only a human eye settles, and the honest home for a check that cannot be
automated yet.

## Gating is a file property, not a runner property

Jest is configured with `roots: ['<rootDir>/tests']` and
`testMatch: ['**/*.test.ts']`, so `npm run test` collects every lane — live and
eval included. They stay out of CI only because each file selects
`describe.skip` when its env gate is unset. A new live test that forgets this
runs in CI. `scripts/check_live_lane_gates.py` is the mechanical guard.

## Coverage

jest.config.js carries an explicit `collectCoverageFrom` allowlist and per-file
`coverageThreshold` entries, many deliberately low with a comment explaining
what is unreachable without a real DOM. `npm run test:coverage` layers a global
80% threshold on top. Adding a file to the allowlist without its own threshold
therefore pulls the *global* number down and reds the whole run — add both or
neither.
