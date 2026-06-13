# Handoff: Measure next-tool predictability on your real vault

> **STATUS 2026-06-13 — RUN & RESOLVED → SHELVE.** Ran on 3 real vaults (Rose N Thorn,
> Synaptic Labs, Professor Synapse). The first run was a **false green** (the script
> read the outer `toolManager_useTools` wrapper, missed 2 of 3 input-schema generations,
> and self-loops inflated accuracy — all now fixed in the spike). Corrected: exact-tool
> prediction is weak/workload-dependent, next-file prediction fails (cold-start), and
> load-time prefetch has a ~16% ceiling. The learned predictor + prefetch are **shelved**;
> the only shipped change is a prompt nudge to batch reads (PR #266). Full verdict +
> numbers: `docs/plans/agent-steering-nudge-plan.md` → "Phase 0 real-data verdict".

> Purpose: the single go/no-go gut-check for the steering-nudge idea
> (`docs/plans/agent-steering-nudge-plan.md`). Run it locally against your real
> tool-call history and read three numbers. Everything downstream depends on
> this; if the signal isn't here, we shelve the idea rather than build on vibes.

## The question this answers

The whole steering design hinges on **confidence-gating**: we only ever prefetch
or nudge when the predictor is *sure*. So the decision isn't "what's the average
next-tool accuracy" (synthetic said ~61% — mediocre). It's:

> **On your real data, what fraction of next-tool transitions clear a high
> confidence bar, and how accurate are we on that slice?**

If a meaningful share of steps are confidently predictable, prefetch is worth
building. If the confident slice is tiny or inaccurate, it isn't.

## What it does (and doesn't)

- Reads the JSONL trace store directly — **no Obsidian, no SQLite, fully local**. Only tool names + session ids are touched; **no note content is read or leaves your machine.**
- Reconstructs per-session tool sequences (expanding batched `useTools` calls), splits **time-ordered** (older sessions predict newer), builds 1st- and 2nd-order Markov models, and reports accuracy vs coverage at confidence thresholds.
- It is **frequency-based**, not success-weighted (we don't have the reward signal wired yet). Treat the numbers as the *predictability ceiling* — success-weighting reshuffles which transitions win, it won't dramatically raise the ceiling.

## How to run

1. Find your trace data dir — the folder containing `workspaces/`. Default:
   ```
   <your-vault>/Nexus/data
   ```
   (If you changed the storage root, use that. Legacy fallbacks: `<vault>/.nexus/data`, or `<vault>/.obsidian/plugins/<nexus-folder>/data`. The script recurses, so pointing at the vault root works too — just slower.)

2. From the repo, after `npm install`:
   ```bash
   NEXUS_TRACE_DIR="/abs/path/to/your-vault/Nexus/data" \
     npx jest tests/spikes/measure-next-tool-predictability.test.ts
   ```
   Without `NEXUS_TRACE_DIR` the test is skipped, so it never runs in CI.

3. Copy the printed `=== NEXT-TOOL PREDICTABILITY ===` JSON block back here.

## How to read the output

```jsonc
{
  "sessions": 312, "totalSteps": 4180, "toolVocab": 41, "avgSessionLen": 13.4,
  "TOOL_LEVEL": {
    "bigram":  { "overall": 0.58, "gated": { "0.8": { "coverage": 0.22, "accuracy": 0.91, "n": 410 }, ... } },
    "trigram": { "overall": 0.71, "gated": { "0.8": { "coverage": 0.34, "accuracy": 0.95, "n": 520 }, ... } }
  },
  "FAMILY_LEVEL_inspect_explore_exploit": { "bigram": { "overall": 0.74, "gated": { ... } } }
}
```

- **`sessions` / `totalSteps`** — data scale. Below ~a few hundred steps the numbers are noisy (the script warns under 200).
- **`overall`** — ungated top-1 accuracy. Expect it mediocre; not the decision number.
- **`gated["0.8"]` = `{ coverage, accuracy, n }`** — *this is the decision number.* Of the transitions where the model is ≥80% confident: `coverage` = what fraction of all scored steps that is, `accuracy` = top-1 accuracy on them, `n` = count.
- **TOOL_LEVEL** = predict the exact tool (`agent_mode`). **FAMILY_LEVEL** = predict only the mode (inspect / explore / exploit) — coarser, so higher coverage; still useful because the read-only families (inspect/explore) are exactly the safe-to-prefetch ones.
- **bigram vs trigram** — if trigram's coverage/accuracy is clearly higher, 2nd-order history is worth using (matches the literature).

## Decision rule (sober)

| `gated["0.8"]` (best of tool bigram/trigram) | Read |
|---|---|
| coverage ≥ ~0.20 **and** accuracy ≥ ~0.88 | **Green for prefetch.** A meaningful slice of steps is confidently predictable; silent read-only prefetch is worth building. Worded nudges still need a live A/B. |
| coverage ~0.05–0.20, accuracy ≥ ~0.85 | **Marginal.** Prefetch might help on a thin slice; probably not worth the complexity yet. Re-measure after more usage. |
| coverage < ~0.05, or accuracy < ~0.8 even when confident | **Shelve it.** Your tool usage isn't Markov-predictable enough; the nudge/prefetch idea doesn't pay off. This is a fine outcome — the gut-check did its job. |

Check the FAMILY_LEVEL row too: even if exact-tool prediction is weak, confidently predicting the *mode* (e.g., "next is read-only") is enough to drive read-only prefetch.

## Caveats (don't over-read)

- Single user, single vault, frequency-based, time-ordered split. The result is directional, not a guarantee.
- "Unseen context" transitions aren't scored (we'd stay silent on them), so `coverage` is over contexts the model has seen before — sparse vocab + little data will show low coverage simply from cold-start, not necessarily low predictability.
- This says nothing about the *value* of nudging (asymmetric cost of wrong nudges), reward gaming, or non-stationarity — those need the live system, not this measurement.

## What to send back

The full JSON report block, plus rough sense of how long you've been using Nexus in that vault (so we can judge whether low coverage is cold-start or a real ceiling).
