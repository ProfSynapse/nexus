# BasesManager agent (`.base` files) — plan

Status: **proposed**
Date: 2026-08-14
Related: `src/agents/canvasManager/` (shape to mirror), Obsidian API ≥ 1.10.0
(`BasesConfigFile`, `BasesQueryResult`, `registerBasesView`), kepano/obsidian-skills
`skills/obsidian-bases`

## Gap

Nexus has no `.base` support of any kind — no reads, no writes, no awareness.
Bases are Obsidian's native database view, and they're exactly the artifact an
agent should be able to produce after organising a set of notes: "give me a
table of every note tagged `task` with days-until-due" is a one-file answer today
and we can't produce it.

`.canvas` has an agent. `.base` is the other first-class non-Markdown Obsidian
file type and it doesn't.

## Tools

New always-on agent, CLI slug `base`, no credentials, cross-platform.

| Tool | Behaviour |
|------|-----------|
| `read` | Parse a `.base` and return its sections (the file's *config*) |
| `write` | Create a NEW `.base`; fails if it exists |
| `update` | Modify an EXISTING `.base`; fails if it does not exist |
| `list` | List `.base` files with view/formula counts (mirrors canvas node/edge counts) |
| `analyze` | Execute the base and return the **rows the user would see** |

There is deliberately **no `validate` tool**. Validation is not a thing a caller
should have to remember to do — `write` and `update` validate before touching
disk and reject with the specific reasons on failure. A separate validate tool
would be a footgun (a model can skip it) and redundant (a rejected write is
already a dry run that tells you exactly what's wrong). Errors come back as a
structured list, not a single string, so a model can fix each one.

`update` replaces only the top-level sections supplied (`filters`, `formulas`,
`properties`, `summaries`, `views`) rather than rewriting the file, so a model
editing one view doesn't silently drop the user's others. This differs from
`canvas update`, which replaces whole arrays; the divergence is deliberate and
belongs in the tool description.

### Registration (two touchpoints, per CLAUDE.md)

1. `initializeBasesManager()` in `src/services/agent/AgentInitializationService.ts`
   (mirror `initializeCanvasManager`, :126–132).
2. `this.safeInitialize('basesManager', …)` alongside the `canvasManager` entry
   in `src/services/agent/AgentRegistrationService.ts:176`.

## Schema: use Obsidian's own types, don't hand-roll

Obsidian's public typings (verified in `obsidian@1.13.1`) ship the serialized
`.base` format:

- `BasesConfigFile` — `filters?`, `formulas?`, `properties?`, `summaries?`, `views?`
- `BasesConfigFileFilter` — `string | { and: … } | { or: … } | { not: … }`
- `BasesConfigFileView` — `{ type, name, filters?, groupBy?, order?, summaries?, limit? }`

So our `types.ts` should re-export those rather than duplicate them, and the
schema tracks Obsidian automatically. kepano's skill is still the best reference
for *semantics* — the function catalogue, property namespaces (`file.*`,
`formula.*`, bare frontmatter), and the documented pitfalls — but the structural
shape is typed for us.

YAML via Obsidian's `parseYaml` / `stringifyYaml`, **not** the `yaml` npm package
(desktop-only per CLAUDE.md; `SkillValidator` set this precedent). Always
serialise through `stringifyYaml` rather than string templates: it handles the
quoting rules that are the largest single source of broken bases.

## Validation rules (run automatically on write/update)

Errors — reject the write:

1. Parses as YAML; no unknown top-level keys.
2. Every filter object has **exactly one** key, and it is `and`/`or`/`not`.
3. `groupBy.direction` is `ASC`/`DESC`.
4. Every `formula.X` referenced from `order`, `properties` or `summaries` exists
   in top-level `formulas`.
5. Every value in a view's `summaries` is a built-in summary name (Average, Min,
   Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty,
   Filled, Unique) or a key in top-level `summaries`.

Warnings — write proceeds, warnings returned:

6. `views[].type` outside `table|cards|list|map`. Note `BasesConfigFileView.type`
   is typed as `string`, not an enum, precisely because plugins register custom
   view types via `registerBasesView` — so an unknown type is suspicious, not
   invalid, and must not be a hard reject.
7. **Duration lint.** Date subtraction yields a Duration, which has no
   `.round()`/`.floor()`/`.ceil()`. Flag `(a - b).round(` with no intervening
   `.days`/`.hours`/`.minutes`/`.seconds`. kepano documents this as the
   number-one authoring error.
8. `order` references a frontmatter property that appears in no note — usually a
   typo, but legitimately can precede the notes that will have it.

## `analyze` — returning the data the user would see

This is feasible **without reimplementing anything**, because Obsidian's own
query engine is exposed. `BasesQueryResult` (public since 1.10.0) carries:

- `data: BasesEntry[]` — filtered, sorted, limited, **formulas already evaluated**
- `groupedData: BasesEntryGroup[]` — grouped per `groupBy`
- `properties: BasesPropertyId[]` — the user's visible columns
- `getSummaryValue(controller, entries, prop, summaryKey)` — footer aggregates

and `BasesEntry.getValue(propertyId): Value | null` reads a cell.

The catch: `QueryController` is an opaque exported class with no public members.
You cannot construct one and ask it to run a config. The only supported way to
receive one is `Plugin.registerBasesView(viewId, { name, icon, factory })` —
Obsidian calls the factory with a live controller when it renders a base using
that view type.

### Mechanism

1. At init, register a headless view type (`nexus-analyze`) whose `BasesView`
   subclass renders nothing and simply resolves a promise inside
   `onDataUpdated()` with a snapshot of `data`.
2. On `analyze`, copy the target `.base` to a scratch path under our storage
   root and append a view of type `nexus-analyze` that clones the requested
   view's `filters`/`order`/`groupBy`/`limit`.
3. Render `![[<scratch>.base#__nexus_analyze]]` through `MarkdownRenderer.render`
   into a **detached** container element — embeds support a `#View Name` selector,
   so this executes the query with no leaf, no tab and no visible flicker.
4. Harvest rows via `entry.getValue(prop)`, plus summaries via `getSummaryValue`.
5. Detach the component, delete the scratch file.

Serialise `Value` objects to plain JSON via `toString()`, with `LinkValue`
preserved as a wikilink so results stay actionable.

### Prerequisites and risks

- `registerBasesView` exists only from **1.10.0** and returns `false` when Bases
  is disabled in the vault. Our `minAppVersion` is 1.8.7, so guard with a
  `typeof plugin.registerBasesView === 'function'` capability check and have
  `analyze` report the reason rather than throw. `read`/`write`/`update`/`list`
  are plain file operations and stay available regardless.
- Step 3 is the part to prototype first — if detached rendering doesn't kick off
  a query, fall back to a background leaf and accept a brief flicker.
- `this` in a base resolves to the base file itself, so a scratch copy changes
  what `this` means. Document it; if it bites, inject the temporary view into
  the original file and restore it in a `finally`.
- The harvesting layer must be separate from how the controller was obtained, so
  that if Obsidian later exposes a "run this config" entry point the scaffolding
  collapses to one call.
- Cap rows returned and paginate — a base over a large vault can be thousands of
  entries and this output goes into a model's context.

## Non-goals for v1

- Map-view specific settings (needs the Maps community plugin).
- Generating bases from task boards / workspaces. Attractive follow-up.
- Writing our own filter/formula evaluator. If `analyze` can't use Obsidian's
  engine, the answer is to fix the mechanism, not to reimplement the language.

## Tests

- Validator unit tests per rule, both directions.
- Round-trip: `parseYaml` → mutate → `stringifyYaml` → reparse is stable.
- Fixtures: the two complete examples from kepano's skill (Task Tracker,
  Reading List) must validate clean — a useful external conformance check.
- `analyze` can only be covered end-to-end in a running app; it's a natural first
  customer for the Obsidian CLI smoke lane (see
  `docs/plans/obsidian-cli-verification-plan.md`).
- `tests/unit/shippedGuidanceCommands.test.ts` gates shipped docs against real
  tool slugs, so the CLAUDE.md agent list and tool count need updating in the
  same change (13 → 14 agents, 74 → 79 tools).

## Open question

Whether `storage list` and other file-facing tools currently filter to `.md` and
would hide `.base` files. Worth checking before shipping, so a model that creates
a base can then find it.
