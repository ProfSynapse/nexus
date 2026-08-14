# CLI-backed providers

Context: read before changing anything in an adapter that shells out to a local
CLI, or its auth and normalization helpers. The constraints here are security
properties, not style preferences, and several are easy to "simplify" away.

## Key idea
A CLI-backed provider runs a third-party binary with the user's credentials on the
user's machine. The adapter's job is to keep that process narrow: no ambient
credentials, no persistent writes, no interactive escape hatches, no unbounded
runtime, and no model it was not asked to run.

Note that one such provider occupies a historical provider id that no longer
matches the binary it runs. The id is settings-compatibility surface — do not
rename it to match reality.

## The contract is narrower than HTTP
Print-mode plain-text output. No structured token usage, so cost reporting is
absent by design rather than broken. No tool or function calling — which is
enforced by a dedicated text-only-provider seam consulted by the chat layer, not
by a provider capability flag. Look for that seam before adding a new switch to
express the same limitation.

## Non-negotiable security constraints
- **The auth probe is boolean-only.** It may read the credential file to test that
  a non-empty token exists, and returns only success/failure. It MUST NEVER read,
  log, return, or otherwise capture the token *value*. The probe deliberately does
  not launch a model call, so it stays cheap and cannot fail for unrelated reasons.
- **No persistent writes into the user's provider config directory.** The
  invocation must work without mutating the CLI's own configuration.
- **No permission-skipping flags.** The reason a bounded timeout matters is
  precisely that a headless tool-permission prompt can never be answered.
- **Model selection is a fail-closed allowlist.** The CLI fails *open*: given an
  unknown model it silently substitutes a default and runs it. Nexus must reject
  anything outside the known set before spawning. Keep the direction — a warning
  is not a substitute for a rejection.
- **Provider API keys are stripped from the child environment**, across every
  model family the CLI can front, so it can only use its own file-based auth.

Any sandbox flag is additive defence, not the foundation. The foundation is the
posture above, which holds on every platform; a sandbox flag may only be passed
where its backend is verified to work headlessly.

## Two independent bounds on a hung process
A CLI provider can wedge, and two separate mechanisms bound that:

1. The shared CLI process runner's **inactivity watchdog** — it resets on every
   chunk of output, so a slow-but-talking process is never cut off, and it kills a
   process that has gone completely silent.
2. Any **provider timeout flag** passed on the command line, which is a hard
   total-runtime cap.

Neither implies the other, and the code comments around them have drifted before.
Before changing or raising either, confirm which one is actually active on the
path you are editing.

## Caching
When a request-shaping option is not part of the default cache key, two different
requests can collide. A provider that folds a setting (reasoning effort, for
example) into the model label it passes to the CLI must fold the same thing into
its cache key, or the second setting returns the first setting's answer.

## Related
- Desktop-only gating, Node imports, and process spawning rules: the
  `nexus-mobile-compat` skill. Anything shelling out is desktop-only.
