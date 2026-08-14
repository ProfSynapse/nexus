# BasesManager Agent (`.base` files) — Design Plan

**Status:** Design / pre-architecture
**Date:** 2026-08-14
**Author:** design discussion (ProfSynapse + Claude)
**Prompted by:** review of `kepano/obsidian-skills` (`skills/obsidian-bases`)

## 1. Goal

Give Nexus first-class support for **Obsidian Bases** — the `.base` file, which is
a saved database-style query over the vault rendered as a table, cards, list or
map view.

Two capabilities, not one:

1. **Author** bases — read, create and modify `.base` files, with validation that
   rejects a broken file *before* it reaches disk.
2. **Execute** bases — return the actual rows a user would see when they open the
   base, with filters applied and formulas evaluated.

`.canvas` has had an agent since v1. `.base` is the other first-class
non-Markdown Obsidian file type and we have no awareness of it at all: a model
that has just organised fifty notes cannot produce the one artifact that makes
them navigable.

## 2. Mental model (the important part)

> **A `.base` is a saved query. We own the file; Obsidian owns the engine.**

This split decides every question below.

The **file** is YAML with a documented, *typed* shape — Obsidian's public API
exports `BasesConfigFile` — so authoring it is ordinary structured file work of
the kind `CanvasManagerAgent` already does for `.canvas`.

The **query language** (filters, formulas, durations, summaries) is a real
expression language with its own evaluator inside Obsidian. We must never
reimplement it. Where we need results, we ask Obsidian to run the query and read
out what it computed (§7).

Consequences:

| Property | Decision | Why |
|---|---|---|
| Schema source | **Re-export Obsidian's types** | `BasesConfigFile` is public API; hand-rolling it guarantees drift |
| Validation | **Structural + reference integrity only** | We can prove `formula.x` is undefined; we cannot prove an expression is semantically right without the evaluator |
| Results | **Obsidian's engine via `BasesQueryResult`** | Filters and formulas already evaluated; zero language surface owned by us |
| Availability | **Agent absent when Bases is off** (§3) | A tool that always fails is worse than a tool that isn't offered |
| View types | **Open set** | `BasesConfigFileView.type` is `string` because plugins register their own |

## 3. Availability gating — no Bases, no tools

If the vault has Bases disabled, the `base` tools must not merely fail when
called: **they must not be discoverable at all**. `getTools` is how a model
learns what exists, and advertising a tool that can only return "not available"
wastes a discovery round-trip and invites retry loops.

**Probe.** `Plugin.registerBasesView(viewId, registration)` returns `false` when
Bases is not enabled in the vault (documented in the API, `@since 1.10.0`). That
single call is both the probe and the registration we need for `analyze` — so at
init we attempt to register the headless view (§7) and use the boolean result to
decide whether to register the agent at all:

```ts
// AgentInitializationService — mirrors initializeCanvasManager (:126-132)
initializeBasesManager(): boolean {
  // Below 1.10.0 the method does not exist; above it, false = Bases disabled.
  if (typeof this.plugin.registerBasesView !== 'function') return false;
  const registered = this.plugin.registerBasesView(NEXUS_ANALYZE_VIEW_ID, analyzeViewRegistration);
  if (!registered) return false;
  this.agentManager.registerAgent(new BasesManagerAgent(this.app, this.plugin));
  return true;
}
```

and in `AgentRegistrationService.doInitializeAllAgents()`, alongside the
`canvasManager` entry in PHASE 1 (`:176`). `safeInitialize` already swallows and
logs failures, so a `false` return simply means no agent — the same shape as the
existing `enableSearchModes` / `enableLLMModes` capability flags at `:244-251`.

**Runtime toggling is explicitly out of scope.** If the user enables Bases after
startup, the tools appear on the next reload. Adding/removing an agent at runtime
would make `AppManager` no longer the only dynamic registrar and would trip
exactly the design limit recorded in issue #174 (the `syncToolManagerAgent`
callback-wrap bridge "does not compose for a second one"). Building a second
dynamic registrar to save a plugin reload is not a trade worth making; if this
becomes a real complaint, the fix is the event-based refactor in #174, not a
workaround here.

## 4. Tool surface

Agent `basesManager`, CLI slug `base`. Five tools, four of which mirror
`canvas` 1:1 so there is nothing new to learn.

| Tool | CLI | Purpose |
|---|---|---|
| `read` | `base read --path Notes/Tasks.base` | Return the file's config |
| `write` | `base write --path X.base --config '<yaml/json>'` | Create NEW; fails if exists |
| `update` | `base update --path X.base --views '[…]'` | Modify EXISTING; fails if absent |
| `list` | `base list [--path Folder]` | List `.base` files with view/formula counts |
| `analyze` | `base analyze --path X.base [--view "Active"] [--limit 50]` | Execute and return rows |

### There is no `validate` tool — deliberately

Validation is not something a caller should have to remember. `write` and
`update` validate before touching disk and **reject with the reasons**; a
rejected write is already a dry run that says exactly what is wrong. A separate
`validate` tool would be redundant *and* a footgun — an optional correctness step
is one a model will skip. Errors are returned as a structured array so each can
be fixed independently:

```json
{
  "success": false,
  "error": "Base config is invalid (2 errors)",
  "errors": [
    { "path": "views[0].order[3]", "code": "unknown-formula",
      "message": "order references formula.days_left, which is not defined in formulas" },
    { "path": "filters", "code": "filter-arity",
      "message": "filter object has 2 keys (and, or); exactly one of and|or|not is allowed" }
  ],
  "warnings": [
    { "path": "formulas.age", "code": "duration-arithmetic",
      "message": "(now() - file.ctime).round(0) — Duration has no .round(); access .days first" }
  ]
}
```

### `update` merges top-level sections

`update` replaces only the sections supplied (`filters`, `formulas`,
`properties`, `summaries`, `views`) and leaves the rest untouched, so a model
editing one view cannot silently drop the user's others. This differs from
`canvas update`, which replaces whole arrays; the divergence is deliberate,
because a `.base` is a small hand-tuned document a user edits directly, while a
canvas is bulk generated geometry. The tool description must say so.

### Example returns

`base list`:

```json
{ "success": true, "bases": [
  { "path": "Notes/Tasks.base", "views": 2, "formulas": 3, "hasGlobalFilters": true }
]}
```

`base analyze --path Notes/Tasks.base --view "Active Tasks" --limit 2`:

```json
{ "success": true,
  "view": { "name": "Active Tasks", "type": "table" },
  "properties": ["file.name", "status", "formula.days_until_due"],
  "rowCount": 47, "returned": 2, "truncated": true,
  "groups": [ { "key": "in-progress", "rows": [
      { "file.name": "Ship v6", "status": "in-progress", "formula.days_until_due": 3 },
      { "file.name": "Write docs", "status": "in-progress", "formula.days_until_due": 11 }
  ]}],
  "summaries": { "formula.days_until_due": { "Average": 7.2 } }
}
```

## 5. Schema — re-export, don't hand-roll

Verified against `obsidian@1.13.1` typings:

- `BasesConfigFile` — `filters?`, `formulas?`, `properties?`, `summaries?`, `views?`
- `BasesConfigFileFilter` — `string | { and: F[] } | { or: F[] } | { not: F[] }`
- `BasesConfigFileView` — `{ type: string, name: string, filters?, groupBy?, order?, summaries? }`

`types.ts` re-exports these rather than duplicating them, so the schema tracks
Obsidian automatically across app updates.

kepano's `obsidian-bases` skill remains the reference for **semantics** — the
function catalogue (`references/FUNCTIONS_REFERENCE.md`), the three property
namespaces (bare/`note.*` frontmatter, `file.*` metadata, `formula.*` computed),
the `this` keyword, and the authoring pitfalls that inform §6.

**YAML via Obsidian's `parseYaml` / `stringifyYaml`**, never the `yaml` npm
package — it is on the CLAUDE.md desktop-only list, and `SkillValidator`
(`src/agents/apps/skills/services/SkillValidator.ts`) already set this
precedent. Always serialise through `stringifyYaml` rather than string templates:
quoting is the largest single source of broken bases, and the serialiser handles
it for free.

## 6. Validation (automatic, on every write)

**Errors — reject the write:**

| Code | Rule |
|---|---|
| `yaml-parse` | File parses as YAML |
| `unknown-key` | No unknown top-level keys |
| `filter-arity` | Every filter object has exactly one key, and it is `and`/`or`/`not` |
| `group-direction` | `groupBy.direction` is `ASC` or `DESC` |
| `unknown-formula` | Every `formula.X` in `order`/`properties`/`summaries` exists in `formulas` |
| `unknown-summary` | Each view summary value is a built-in name or a key in top-level `summaries` |

Built-in summary names: Average, Min, Max, Sum, Range, Median, Stddev, Earliest,
Latest, Checked, Unchecked, Empty, Filled, Unique.

**Warnings — write proceeds:**

| Code | Rule |
|---|---|
| `unknown-view-type` | `type` outside `table\|cards\|list\|map` — see below |
| `duration-arithmetic` | `(a - b).round(` with no intervening `.days`/`.hours`/`.minutes`/`.seconds` |
| `unused-property` | `order` references a frontmatter property no note currently has |

`unknown-view-type` **must not be an error.** `BasesConfigFileView.type` is typed
as `string`, not a union, precisely because plugins register their own view types
via `registerBasesView` — our own `nexus-analyze` is one. Rejecting unknown types
would make us reject files that Obsidian renders fine, including files we wrote.

`duration-arithmetic` is a warning rather than an error because we are pattern
matching on an expression language we do not parse; it is kepano's documented
number-one authoring error, so it earns a flag but not a veto.

## 7. `analyze` — executing the query

Obsidian exposes the whole result set as public API (`@since 1.10.0`):

- `BasesQueryResult.data: BasesEntry[]` — filtered, sorted, limited, **formulas
  already evaluated**
- `.groupedData: BasesEntryGroup[]` — grouped per the view's `groupBy`
- `.properties: BasesPropertyId[]` — the user's visible columns
- `.getSummaryValue(controller, entries, prop, key): Value` — footer aggregates
- `BasesEntry.getValue(propertyId): Value | null` — one cell

**The obstacle:** `QueryController` is an exported class with *no public members*.
It cannot be constructed, and nothing accepts a `BasesConfigFile` and returns
results. The only supported way to receive a live controller is
`registerBasesView(viewId, { name, icon, factory })` — Obsidian calls the factory
when it renders a base **using that view type**.

**Mechanism:**

1. At init (§3), register `nexus-analyze`: a `BasesView` subclass that renders
   nothing and resolves a pending promise inside `onDataUpdated()` with a
   snapshot of `data`.
2. On `analyze`, copy the target `.base` to a scratch path **beside the source
   base** (not under the storage root), whose single view is of type
   `nexus-analyze` and clones the requested view. [BUILT 2026-08-14, Phase 3:
   the storage root is configurable and may be a dot-folder, which `app.vault`
   does not index at all — the embed would then silently resolve to nothing. A
   sibling also keeps `file.folder` semantics identical. The scratch file is
   prefixed `__nexus-analyze-`, hidden from `base list`, excluded from its own
   results, deleted in a `finally` via `adapter.remove` (NOT trashed — it would
   drop a file in the user's trash on every call), and any leftover is swept on
   the next call.]
3. Render `![[<scratch>.base#<generated view name>]]` via `MarkdownRenderer.render`
   into a container that is **attached to the document but positioned
   off-screen** (`position:absolute; left:-10000px`, 1×1). Base embeds accept
   a `#View Name` selector, so this executes the query with no leaf and no
   tab.

   **A detached container does not work, and this is by design.**
   `QueryController.runQuery` gates on `viewContainerEl.isShown()`, which is
   `!!this.offsetParent` — detached means `offsetParent === null`, so it awaits
   `onNodeInserted` forever, `initialScan` stays true, and `onDataUpdated` is
   never called. The view is constructed and `onload` fires, which makes the
   failure look like a timing problem rather than a permanent one.
   `display:none` fails for the same reason. Anything preserving a layout box
   works — `visibility:hidden` and off-screen positioning both do.
   [VERIFIED 2026-08-14, Obsidian 1.13.7: 8 isolated trials; 13 consecutive
   off-screen 300-row renders produced byte-identical screenshots, so there is
   no flicker.]
   The `sourcePath` passed to `MarkdownRenderer.render` is the **original**
   base, not the scratch copy — that is what `this` and links resolve against.
4. Harvest rows through `entry.getValue(prop)`; summaries through
   `getSummaryValue`. The registered view hands the whole live view to the
   runner and does no serialising itself: Obsidian keeps the FIRST registration
   for the life of the app process, so the view's code may belong to an older
   build of Nexus than the runner's. That makes the view↔runner handover a
   versioned wire protocol (`ANALYZE_PROTOCOL_VERSION`), and lets `analyze` say
   "restart Obsidian" instead of hanging when it meets a pre-Phase-3 view.
5. Unload the `Component`, delete the scratch file in a `finally`.

**Serialisation.** `Value` subclasses (`StringValue`, `NumberValue`, `DateValue`,
`ListValue`, `LinkValue`, …) go to plain JSON via `toString()`, with `LinkValue`
preserved as a wikilink so results stay actionable — a returned row should be
something the model can immediately `content read`.

**Bounding.** A base over a large vault is thousands of entries and this output
lands in a model's context. Default `limit` (25), always report `rowCount` vs
`returned` and a `truncated` flag; never silently drop rows. [MEASURED
2026-08-14: 300 rows execute in 75 ms and return 25 with `truncated: true`.]

**A broken filter is undetectable, and `analyze` says so.** The plan assumed the
rendered container would carry the failure. It does not. [VERIFIED 2026-08-14,
Obsidian 1.13.7: a view filtering on an undefined function and a view whose
filter simply matches nothing produce byte-identical rendered HTML (4975 bytes,
modulo the generated view name), log nothing to the console, raise nothing, and
both return `[]` from Obsidian's own `base:query`.] The only text in the
container is the Bases toolbar chrome, present on every run. So zero rows is
returned as an empty result set carrying a warning that empty has two meanings —
failing the call instead would make every legitimately empty base look broken.

**Serialisation, verified.** `Value.type` on an INSTANCE is a getter returning
the constructor; calling it re-runs the constructor over the live value. The
class-level `static type` is read off the prototype instead, and its values are
CAPITALISED in the shipped app (`'String'`, `'Number'`, `'Null'`, `'List'`,
`'Link'`, `'Date'`) — matching them lowercase silently disables every typed
branch, which is how a missing property first came back as the *string* `"null"`
(`NullValue.toString()` is the four characters `null`). `constructor.name` is
useless: the app is minified and every `Value` class is named `t`.

**Layering.** The harvesting code must not know how the controller was obtained.
If Obsidian later exposes a "run this config" entry point, steps 2–3 and 5
collapse to one call and nothing else changes.

## 8. Mobile / desktop split

All five tools are cross-platform in principle: YAML through Obsidian helpers,
files through the vault API, and the Bases engine ships with the app on both
platforms. Bases availability, not platform, is the gate (§3).

`analyze` needs verification on mobile — detached `MarkdownRenderer` rendering is
the uncertain part, and the mobile adapter has surprised us before (the
`adapter.list('')` vs `'/'` vault-root discovery issue in the Skills app). If it
proves unreliable there, gate `analyze` alone rather than the agent.

## 9. Phasing

| Phase | Content | Gate |
|---|---|---|
| 0 | **Spike `analyze` step 3** — does detached embed rendering execute the query? | Decides §7; do this first |
| 1 | Agent scaffold + availability probe (§3) + `read`/`list` | Tools appear only when Bases is on |
| 2 | `BaseValidator` (§6) + `write`/`update` with automatic validation | kepano fixtures validate clean |
| 3 | `analyze` (§7) | Rows match what the app shows for the same base — **done 2026-08-14**, differentially verified against `base:query` on 5 views + a 300-row base, 0 cell mismatches |
| 4 | Docs: CLAUDE.md agent list + tool counts, `cli-first-tool-schemas.json` | `shippedGuidanceCommands.test.ts` green |

Phase 0 first is the point of the phasing: it is the only part that can fail
outright, and everything else is ordinary file work that does not depend on the
answer.

## 10. Open questions

1. ~~Does detached rendering kick off a query?~~ **RESOLVED** — no, but
   off-screen-attached does, in ~85 ms flat regardless of row count. The
   background-leaf fallback is **worse and should not be used**:
   `setViewState({active:false})` still pulled the tab to the front, and a
   collapsed-sidebar leaf created the view without ever running the query —
   visible when it works, silent when it does not.
2. ~~**`this` semantics under a scratch copy.**~~ **RESOLVED** — no fallback
   needed. Obsidian resolves `this` against the `sourcePath` handed to
   `MarkdownRenderer.render`, and the runner passes the ORIGINAL base path. A
   formula `this.file.name` therefore returns the source base's name, not the
   scratch copy's [VERIFIED 2026-08-14, Obsidian 1.13.7], which is exactly the
   binding the base gets when opened in a tab. `analyze` still warns when a base
   uses `this`, because a base the user normally EMBEDS in a note binds `this`
   to that note. Note that Obsidian's `base:query` CLI returns 0 rows for such a
   base, so `analyze` is strictly better here — and the differential oracle
   cannot be used on `this`-bearing bases.
3. **Do `storage list` / file-facing tools filter to `.md`?** If so a model can
   create a base and then not find it. Check before shipping.
4. **Should `analyze` accept an inline config** (execute without a file)? Would
   make bases a general query interface. Attractive, out of v1 scope.

## 11. Implementation reuse map (DRY)

| Need | Reuse |
|---|---|
| Agent + lazy tool registration | `src/agents/canvasManager/canvasManager.ts` (registerLazyTool shape) |
| Read/write/update/list tool shapes | `src/agents/canvasManager/tools/*` |
| Registration touchpoints | `AgentInitializationService.ts:126-132`, `AgentRegistrationService.ts:176` |
| Capability-flag registration | `enableSearchModes` / `enableLLMModes`, `AgentRegistrationService.ts:244-251` |
| YAML parse/serialise | Obsidian `parseYaml`/`stringifyYaml`, as in `SkillValidator` |
| Collected-errors validator shape | `SkillValidator.validate()` (collects all errors, no short-circuit) |
| Scratch paths under storage root | `resolveVaultRoot(settings, { configDir })` |
| Structured tool results | `BaseTool.prepareResult` |

## 12. Non-goals

- Writing our own filter/formula evaluator. If `analyze` cannot use Obsidian's
  engine, the answer is to fix the mechanism, not to reimplement the language.
- Map-view-specific settings (needs the Maps community plugin).
- Generating bases from task boards or workspaces — attractive follow-up, but it
  presumes the file tools are proven.
- Runtime enable/disable of the agent (§3).

## 13. Prior art in the Obsidian CLI

`obsidian-cli` already ships a `base:query` command with `json|csv|tsv|md|paths`
output. It is CLI-surface only, so it does not replace `analyze` for an in-app
agent — but it is an excellent **differential-test oracle**: run a base through
both and compare. Use it in the Phase 3 tests rather than hand-asserting rows.

## 14. Tests

- Validator unit tests per rule code, both directions.
- Round-trip stability: `parseYaml` → mutate → `stringifyYaml` → reparse.
- Fixtures: the two complete examples from kepano's skill (Task Tracker, Reading
  List) must validate clean — an external conformance check we didn't author.
- `analyze` is only truly testable in a running app; it is the natural first
  customer for the Obsidian CLI smoke lane
  (`docs/plans/obsidian-cli-verification-plan.md`).
- `tests/unit/shippedGuidanceCommands.test.ts` gates shipped docs against real
  tool slugs, so the CLAUDE.md agent inventory and tool counts must move in the
  same change.
