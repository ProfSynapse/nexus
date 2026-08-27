# The live provider smoke lane

`tests/debug/provider-model-live-smoke.test.ts` calls a real provider endpoint
through the real adapter with one short prompt. It is the only check in the repo
that can tell you a model id exists. Read this before the first run; read the
test file's own header for the current invocation, since it is maintained
alongside the code and this file is not.

## Key idea
The lane answers exactly one question: does this provider accept this id and
return text through our adapter. It is skipped by default, it spends real
credentials, and two of its failure modes look like a dead model id but are not.

## Running it
The suite is skipped unless the run flag is set — a bare `npx jest` on this file
reports skipped, not passed. One provider and model:

```bash
RUN_MODEL_SMOKE=1 MODEL_SMOKE_PROVIDER=<provider> MODEL_SMOKE_MODEL=<id> \
  npx jest tests/debug/provider-model-live-smoke.test.ts \
  --runInBand --no-coverage --verbose
```

With no provider filter it runs every provider it knows how to construct, each
resolving its default from the central `DEFAULT_MODELS` map unless overridden.
Per-provider model overrides exist as environment variables so a full sweep can
pin one provider without pinning the rest; the test file lists their exact names
and the provider union it accepts. That union is smaller than the set of
providers in the app — locally-served, CLI-backed and some gateway providers have
no adapter construction here at all. If yours is not in it, the lane cannot
verify your id and your report must say so rather than implying coverage.

## Credentials
Keys are read from the environment, falling back to a `.env` file in the
**current working directory**. OAuth-backed providers instead read tokens from a
`data.json` in the working directory — the plugin's own settings file — and need
the provider enabled with a refresh token and account id present, or the lane
throws before making a call.

Two consequences:
- **Run from the repo root.** The `.env` lookup does not walk up the tree, so a
  run from a git worktree or a subdirectory finds nothing and fails on a missing
  key that is plainly present one directory up. Symlink the root `.env` into the
  worktree, or export the variables inline for the command. Do NOT change the
  harness to search parent directories: reaching outside the working directory
  for credentials is a pattern that gets flagged as bypassing deny rules, and the
  symlink is the accepted workaround.
- **Never echo what it reads.** No printing keys, no pasting `.env` or
  `data.json` contents into a report or a commit.

## Id normalization, and how it bites
The lane rewrites the id to suit the provider before calling: an id with no
namespace gets one added for the gateway provider, and a namespace is stripped
for direct providers. The added namespace is a fixed one, so passing a bare id
from a *different* vendor to the gateway produces a confidently wrong id and a
404. Pass gateway ids fully namespaced and the rewrite is a no-op.

The lane then asserts the response reports back the same provider and the same
model string it sent. An adapter that echoes a resolved or rewritten id — a
gateway reporting the upstream model it routed to, for instance — fails the
assertion on a call that actually succeeded. Read the failure message before
concluding the id is bad.

## The three impostors
Before treating a failure as a bad id or a bad key:

1. **Token starvation on a reasoning model.** The lane sends a small output-token
   budget, sized for a non-reasoning model echoing one word. A thinking-capable
   model can consume the entire budget on internal reasoning and return empty
   text, which surfaces as an empty-response failure. Raise the budget via the
   lane's max-tokens environment variable — the test file names it — and re-run
   before suspecting anything else. This is the single most common first failure
   on a newly added reasoning model.

2. **A parameter the endpoint refuses.** Some OAuth-backed endpoints reject
   request parameters their public API accepts; the lane already omits an output
   limit for the one known case. A new provider in the same family may need the
   same treatment, and the symptom is a parameter-rejection error, not a
   model-not-found error.

3. **Upstream saturation on a just-launched gateway model.** The adapter
   surfaces this as an opaque `generation failed: Provider returned error`,
   which reads like a bad id. Reproduce the call with curl against the gateway
   directly and read the error body: a 429 whose metadata names the upstream
   provider's shared pool means the id is fine and the launch-day pool is
   saturated. Retry with backoff — these typically clear within minutes — rather
   than re-spelling the id or touching the entry.

Network or DNS failures in a sandboxed session are a fourth category and mean
the run never reached the provider. Re-run with network access rather than
recording a failure.

## What a pass does not mean
It returned text. It did not call a tool, hold a multi-turn conversation, or
touch a Nexus agent. A model can pass this lane and still be unable to drive the
two-tool protocol the app is built on, which is why a default change needs the
grading in `nexus-model-eval` and not just a green smoke run.
