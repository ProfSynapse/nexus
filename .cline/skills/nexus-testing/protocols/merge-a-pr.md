# Protocol: merge a PR without putting main in a red state

Context: on 2026-08-27 the chain `gh pr checks 368 && gh pr merge 368` merged a
PR past a **failing** CI run and main went red. `gh pr checks` exits 0 whenever
it can *list* checks — a failed check still exits 0 — so its exit code proves
nothing about whether the PR is green. The failure itself was also predictable:
the PR changed `GroqAdapter` behavior and the adapter's own test file, which
pinned the old behavior, was never run locally.

## Steps

1. **Before pushing a behavior change, run the touched component's own test
   file.** Not just `tsc`, not just the files you edited tests for — the
   existing suite that pins the component you changed:

   ```bash
   npx jest tests/unit/<Component>.test.ts --no-coverage
   ```

   Existing tests pin *current* behavior. If your change is a fix, some pin is
   probably now wrong and must be updated in the same PR — CI finding it after
   you merge is the failure mode this protocol exists to prevent.

2. **Gate the merge on parsed check buckets, never on `gh pr checks` exit
   code and never on a `&&` chain.** The only trustworthy form:

   ```bash
   gh pr checks <N> --json bucket -q '[.[].bucket] | unique'
   ```

   Merge only when every bucket is `pass` (or `skipping`). `pending` means
   wait — poll until it resolves; an empty result means checks have not
   started, which is also wait, not proceed.

3. **Merge, then confirm main.** After the merge lands, check the default
   branch's own status before building anything on top of it.

## Guidelines

- On machines with this repo's local merge-gate hook
  (`.claude/hooks/gate-pr-merge.sh`, wired via the gitignored
  `.claude/settings.json`), step 2 is enforced mechanically — `gh pr merge` is
  blocked while any bucket is not pass/skipping. The hook does not travel with
  the repo; on other machines this protocol is the only guard.
- Anti-pattern: `gh pr checks N && gh pr merge N`. This reads like a gate and
  is not one. It is exactly how #368 merged red.
- Anti-pattern: `gh pr checks --watch` as a gate — it can exit while checks
  are still pending, and its exit code has the same problem.
