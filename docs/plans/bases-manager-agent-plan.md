# BasesManager agent (`.base` files) — plan

Status: **proposed**
Date: 2026-08-14
Related: `src/agents/canvasManager/` (shape to mirror), kepano/obsidian-skills
`skills/obsidian-bases`

## Gap

Nexus has no `.base` support of any kind — no reads, no writes, no awareness.
Bases are Obsidian's native database view (YAML files with filters, formulas and
views), and they are exactly the artifact an agent should be able to build after
it has organised a set of notes: "make me a table of every note tagged `task`
with days-until-due" is a one-file answer today and we can't produce it.

`.canvas` has an agent. `.base` is the other first-class non-Markdown Obsidian
file type and it doesn't.

## Shape: mirror CanvasManager exactly

New always-on agent, CLI slug `base`, no credentials, cross-platform.

```
src/agents/basesManager/
  basesManager.ts            # BaseAgent subclass, lazy-registered tools
  tools/{read,write,update,list,validate}.ts
  services/BaseValidator.ts  # pure, dependency-free
  types.ts
```

Tools (first four match `canvas` 1:1, so there is nothing new to learn):

| Tool | Behaviour |
|------|-----------|
| `read` | Parse a `.base` and return its sections + a normalised summary |
| `write` | Create a NEW `.base`; fails if it exists |
| `update` | Modify an EXISTING `.base`; fails if it does not exist |
| `list` | List `.base` files with view/formula counts (mirrors canvas node/edge counts) |
| `validate` | Validate without writing — the pre-flight for a model-authored base |

`update` should replace only the top-level sections the caller supplies
(`filters`/`formulas`/`properties`/`summaries`/`views`) rather than rewriting the
file, so a model editing one view doesn't silently drop the user's other views.
Note this differs from `canvas update`, which replaces whole arrays — the
divergence is deliberate and should be called out in the tool description.

### Registration (two touchpoints, per CLAUDE.md)

1. `initializeBasesManager()` in `src/services/agent/AgentInitializationService.ts`
   (mirror `initializeCanvasManager`, :126–132).
2. `this.safeInitialize('basesManager', …)` alongside the `canvasManager` entry
   in `src/services/agent/AgentRegistrationService.ts:176`.

No factory class, no ServiceDefinitions entry.

## YAML handling

Use Obsidian's `parseYaml` / `stringifyYaml`, **not** the `yaml` npm package —
that package is on the CLAUDE.md desktop-only list, and `SkillValidator` already
set this precedent. Always serialise through `stringifyYaml` rather than string
templates: it handles the quoting rules that are the single largest source of
broken bases (expressions containing `"`, values containing `:`/`{`/`}`).

## Schema to model

```yaml
filters:      # filter node: a string, OR an object with exactly one of and|or|not
formulas:     # name -> expression string
properties:   # property key -> { displayName }
summaries:    # name -> aggregation expression
views:
  - type: table | cards | list | map
    name: string
    limit: number?
    groupBy: { property, direction: ASC|DESC }?
    filters: <filter node>?
    order: string[]?          # file.x | property | formula.x
    summaries: { property: SummaryName }?
```

Property namespaces: bare/`note.x` (frontmatter), `file.x` (name, basename, path,
folder, ext, size, ctime, mtime, tags, links, backlinks, embeds, properties),
`formula.x` (computed).

Built-in summary names: Average, Min, Max, Sum, Range, Median, Stddev, Earliest,
Latest, Checked, Unchecked, Empty, Filled, Unique.

## Validator rules

These are the documented real-world failure modes, not invented strictness:

1. File parses as YAML; unknown top-level keys rejected.
2. Every filter object has **exactly one** key, and it is `and`/`or`/`not`.
3. `views[].type` is in the enum; `groupBy.direction` is `ASC`/`DESC`.
4. Every `formula.X` referenced from `order`, `properties` or `summaries` exists
   in the top-level `formulas`.
5. Every value in a view's `summaries` is either a built-in name or a key in
   top-level `summaries`.
6. **Duration lint (warning).** Date subtraction yields a Duration, which has no
   `.round()`/`.floor()`/`.ceil()`. Flag `(a - b).round(` with no intervening
   `.days`/`.hours`/`.minutes`/`.seconds` field access. kepano documents this as
   the number-one pitfall.
7. Warn when `order` references a frontmatter property that appears in no note
   in the vault — usually a typo, so warn rather than reject.

Rules 1–5 are errors, 6–7 warnings. `write`/`update` run the validator and refuse
on errors; `validate` returns both lists.

## Non-goals for v1

- **Evaluating** filters/formulas against the vault. That is Obsidian's query
  engine and reimplementing it is a project, not a tool. If a model wants
  results rather than a view, `search query-notes` already exists.
- Map-view specific settings (needs the Maps community plugin).
- Generating bases from task boards / workspaces. Attractive follow-up, out of
  scope until the file-level tools are proven.

## Tests

- Validator unit tests per rule, both directions.
- Round-trip: `parseYaml` → mutate → `stringifyYaml` → reparse is stable.
- Fixtures: the two complete examples from kepano's skill (Task Tracker,
  Reading List) must validate clean — a useful external conformance check.
- `tests/unit/shippedGuidanceCommands.test.ts` gates shipped docs against real
  tool slugs, so the CLAUDE.md agent list and tool count need updating in the
  same change (13 → 14 agents, 74 → 79 tools).

## Open question

Whether `storage list` and other file-facing tools currently filter to `.md` and
would hide `.base` files. Worth checking before shipping, so a model that creates
a base can then find it.
