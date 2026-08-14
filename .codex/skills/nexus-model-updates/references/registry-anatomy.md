# Registry anatomy

What a `ModelSpec` field means, what value to put in it, and the local
conventions a registry file carries that its type does not express. Read this
while writing an entry. The interface itself is in
`src/services/llm/adapters/modelTypes.ts` — read it for the authoritative field
list; this file covers the judgment the type cannot encode.

## Key idea
Every field is a claim the app acts on without re-checking. There is no schema
validation, no runtime reconciliation against the provider, and no test that
compares an entry to reality. A wrong value does not throw — it changes
behaviour quietly. `consumers.md` traces each one to what it breaks.

## The fields

**`provider`** — must equal the directory the registry lives in. The aggregators
label a model from this field, not from the map key they filed it under, so a
mismatch files the model under a provider that does not own it. The gate checks
this.

**`name`** — the human label in the picker. This is the only field with no
downstream logic, so it is the right place to disambiguate entries that share an
id: a variant pair is distinguishable to a user only by its name.

**`apiName`** — the id sent to the provider, verbatim. Not a slug you tidied, not
the marketing name. Two rules follow from that:
- Gateway providers expect an upstream-namespaced id (`vendor/model`). Direct
  providers expect the bare id. The same model therefore has two different
  `apiName` values in two different registries, and copying one into the other
  produces a 404 at the first call.
- Subscription- and CLI-backed providers accept their own slugs, which need not
  match the vendor's public API ids even for the same underlying model. Confirm
  availability through *that* endpoint before adding an entry to it.

**`contextWindow` / `maxTokens`** — input window and max output tokens. Both are
displayed and both feed budgeting, so an inflated window shows up as a request
the provider rejects rather than as a warning.

**`inputCostPerMillion` / `outputCostPerMillion`** — USD per million tokens,
Standard tier. Use `0` for both where the provider bills by subscription rather
than by token (OAuth- and CLI-backed providers) and where the model runs locally.
Zero here means "no per-token billing", not "unknown" — leaving a real price at
zero makes spend silently invisible.

**`capabilities`** — all five flags, always. An omitted flag reads as
unsupported, and the failure is an affordance that never appears rather than an
error:
- `supportsJSON` — structured-output requests.
- `supportsImages` — image input.
- `supportsFunctions` — tool calling. Nexus drives models through a two-tool
  protocol, so a model with this false cannot do the thing the app is for.
- `supportsStreaming` — incremental output.
- `supportsThinking` — reasoning. This flag alone decides whether the reasoning
  toggle and effort control render at all; set it false on a reasoning model and
  users simply have no way to turn thinking on.

**`betaHeaders`** (optional) — provider beta opt-in headers the adapter attaches
when the model is selected. This is how a capability that requires a header,
rather than a parameter, gets expressed.

## Variant pairs: two entries, one id
A provider sometimes exposes the same model under one id with a header or suffix
selecting a larger context window. The convention is two entries sharing an
`apiName`, differing in `contextWindow` (and carrying the beta header on the
larger), with the display `name` distinguishing them.

This only works where the adapter has an explicit disambiguation rule — it
synthesizes a suffixed id for the picker and strips the suffix before the
request, and lookup consults `contextWindow` to pick the right entry. Where a
provider has no such rule, a duplicated `apiName` means lookup returns whichever
entry comes first and the other is unreachable: it appears in the picker,
selects the same underlying configuration, and the extra window silently never
applies. The gate warns on every duplicate id so the pair is a deliberate choice
rather than an accident.

## Registries that are fallbacks, not catalogs
Some adapters query the provider for its current model list and merge or
overwrite the static array. There, the array only has to be good enough for first
paint and its ids still have to be slugs the provider accepts today. The gate
detects this structurally — a provider whose adapter calls a model-listing
endpoint gets shape problems reported as warnings rather than errors.

## Lookup
Field-level questions the type does not answer:

| Question | Answer |
|---|---|
| Model has no published price (subscription/local) | `0` / `0` |
| Model id differs between direct and gateway access | Two entries, two registries, two `apiName` values |
| Not sure whether tools are supported | Not a guess — go back to the provider's docs |
| Model needs a beta header | `betaHeaders`, not a capability flag |
| Two entries would share an id | Only where the adapter disambiguates; otherwise one entry |
