---
name: nexus-model-updates
description: Add, change or verify a Nexus LLM model definition — the registry entry, the provider default, and proof the model id actually works against the live endpoint. Use when adding a newly released model, editing model metadata such as pricing, context window or capability flags, promoting a provider default, standing up a model registry for a new provider, or checking whether a model id resolves through the live provider smoke lane.
---

# Nexus model updates

Each provider keeps a static model catalog at
`src/services/llm/adapters/<provider>/<Provider>Models.ts`: an array of
`ModelSpec` literals plus a `*_DEFAULT_MODEL` export. Two aggregators read those
arrays, and between them they decide what the model picker offers, what a call
costs, and which UI affordances appear.

Nothing here holds model ids, prices, context windows or provider lists — the
registries are the truth and they change weekly. This skill holds the procedure
and the checks. To see what the tree currently declares:

```bash
python3 .claude/skills/nexus-model-updates/scripts/check_model_registry.py \
  --repo-root . --list
```

## Workflow
1. **A model in a provider that already has a registry** — follow
   `protocols/add-model.md`. Get every number from the provider's own source;
   values carried over from another gateway's entry are wrong more often than
   they are right.
2. **Moving a provider's default** — follow `protocols/change-default.md`. The
   default is written in several independent places and TypeScript checks none of
   them against each other, so you MUST work that protocol rather than editing
   the one you happened to find.
3. **A provider with no registry yet** — follow
   `protocols/add-provider-registry.md`. Adapter wiring belongs to
   `nexus-llm-adapters`; only the catalog and its aggregator entries are yours.
4. **An image generation model** — follow `protocols/add-image-model.md`. Image
   models live in the image adapters' own catalogs, not in `<Provider>Models.ts`,
   the structural gate does not see them, and the committed tool catalogs embed
   their enum.
5. **Before calling any of the above done** — run `protocols/verify-model.md`. You
   MUST get a zero exit from
   `scripts/check_model_registry.py --repo-root . <provider>`, and you MUST NOT
   report a model as working on the strength of a registry entry: the entry is a
   claim about an id, and only a live call tests it.
6. **End of a session that used this skill** — run `protocols/self-refine.md`.

## Map
- `protocols/` the procedures: add-model, add-image-model, change-default,
  add-provider-registry, verify-model, self-refine.
- `references/` mechanism, read on demand: `registry-anatomy.md` (what a
  `ModelSpec` field means and how to fill it), `consumers.md` (who reads the
  registries and what silently breaks when metadata is wrong),
  `smoke-harness.md` (the live provider smoke lane in detail).
- `scripts/check_model_registry.py` — the structural gate: required fields,
  provider/directory agreement, unreachable duplicate ids, defaults that point at
  nothing, adapter literals that drifted from the registry, and registries wired
  into one aggregator but not the other. Run it; do not re-derive it by reading
  source.

## Siblings — do not duplicate them here
- **`nexus-llm-adapters`** owns adapter wiring: transport, streaming, reasoning
  rendering, and the provider registration points outside the model catalog.
- **`nexus-model-eval`** owns grading a model on Nexus tool use. A smoke test
  proves the id returns text; it proves nothing about tool calling, and a model
  that passes smoke can still be unusable in chat.
- **`nexus-eval-harness`** owns running and changing the eval harness itself.
- **`nexus-testing`** owns which Jest lane to use and what a mock can prove.

## Refine
At the end of a session that used this skill, run `protocols/self-refine.md` and
append to `refinement-log.md`.
