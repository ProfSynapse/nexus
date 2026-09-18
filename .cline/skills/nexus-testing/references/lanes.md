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
what is unreachable without a real DOM.

**The two coverage commands do not read the same thresholds.** A CLI
`--coverageThreshold` *replaces* the config object rather than merging into it,
and `npm run test:coverage` passes one (`package.json`):

| Command | Thresholds actually applied |
|---|---|
| `npx jest --coverage` | the per-file entries in jest.config.js; no global gate |
| `npm run test:coverage` | one global 80% gate; **every per-file entry is ignored** |

So adding a file to `collectCoverageFrom` pulls the global number down under
`npm run test:coverage`, and giving it a per-file threshold does **not** protect
it there, because that entry is not read by that command. Add the per-file entry
anyway, because a bare `jest --coverage` does read it and that is where a
per-file ratchet belongs, but do not expect it to keep `test:coverage` green.

Note that `npm run test:coverage` is red on main and has been for some time
(76.44% statements against the 80% gate, all four global thresholds failing),
so it is not a gate anything currently passes. `npm run test` is the gate that
matters. Verify with:

```bash
npm run test:coverage 2>&1 | grep "coverage threshold"   # global lines only
npx jest --coverage 2>&1 | grep "coverage threshold"     # per-file lines
```
