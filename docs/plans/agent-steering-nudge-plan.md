# Implementation Plan: Learned Agent Steering / Next-Step Nudges

> Status: **HYPOTHESIS — unvalidated.** No production code. Gated behind synthetic gut-checks (below) that can kill it. — created 2026-06-13
> Sibling to `local-embedding-adapter-plan.md` (reuses its trace store, dream loop, bake-off, promotion gate, debiasing). This doc is deliberately skeptical: the burden is on the design to survive falsification, not on the reader to be convinced.

## Summary

Learn the most-likely-*useful* next tool-call from the user's own tool-call trajectories and use it two ways: (a) **silently prefetch** the read-only candidate (schema and/or result) so it's cheap when used; (b) **optionally** surface a low-pressure worded nudge for high-confidence *action* steps. Same engine as the retrieval adapter (learn-from-traces → dream-train → bake-off → promote → debias), head swapped from "rank notes" to "rank the next move."

## Why this might NOT work (read this first)

These are the reasons to expect failure. The synthetic gut-checks exist to test them before we spend effort.

1. **The worded nudge may be net-negative.** Published next-action accuracy is ~55% (Speculative Actions, 2026). The steering literature is consistent that wrong nudges hurt *more* than right ones help, and are followed *silently* ("Unspoken Hints" 2025; FlipFlop 2023). At 55% accuracy with asymmetric cost, expected value of a worded nudge can be **negative**. The *prefetch* (read-only, no persuasion) is the only part that's clearly safe. We should assume the worded nudge is a liability until proven otherwise.
2. **Per-user reward is sparse and slow.** Task completions are rare events; the signal that matters most (causal downstream use) is rarer still. We may never accumulate enough per-user data before the user's workflows shift (non-stationarity). The whole thing could starve.
3. **"Causal-use" reward is hard to actually measure.** Proof-of-Use (2025) uses citations; we'd need to trace data-dependencies across tool calls, which our traces may not capture cleanly. A nice principle that may be unreliable in practice.
4. **Complexity stacking.** Markov predictor + two-head ranker + IPS debiasing + causal-use reward + confidence gate + prefetch cache + bake-off is a lot of interacting parts. Each is individually defensible; the combination is a large untested surface. Build the smallest falsifiable piece first.
5. **Predictability assumption.** AutoTool (2025) claims tool sequences are near-Markov *on their datasets*. Unverified on our vocabulary and a single user's idiosyncratic, multi-goal usage, where the next tool may be far less determined.

## Phase 0 — Synthetic gut-checks (falsification gates) — START HERE

Before any wiring, answer these on synthetic data, and **accept a "no":**

- **GC-1 (predictability + value of success-weighting):** generate tool-call sessions from a known generative process (a few successful workflow templates + realistic noise/ambiguity). Does a success-weighted low-order Markov predictor beat raw-frequency and uniform on held-out *successful* sessions? **And — the decision-relevant number — what is its absolute top-1 accuracy?** If absolute accuracy is low (say <70%), the worded nudge is probably net-harmful and we ship *prefetch-only*.
- **GC-2 (reward gaming resistance):** simulate a genuine-work population and a reward-farmer (spawns trivial same-session tasks; also a *sneaky* farmer that mislabels provenance). Does the reward gating (hard-zero for agent-self-created same-session + causal-use + substance) drive farmer reward to ≈0 while paying genuine work? If the farmer leaks reward, the reward design is broken.

Only if GC-1 shows usable accuracy and GC-2 holds do we proceed — and even then, prefetch before nudge.

### Phase 0 results (2026-06-13) — `tests/spikes/steering-gut-check.test.ts`

Run on synthetic data with deliberately ambiguous exploit branches + state-overlapping noise:

```
GC-1  ungated top-1 accuracy:  success-weighted 0.61 | raw-frequency 0.577 | majority 0.39
GC-1b confidence-gated:        conf>=0.5 → acc 0.77 @ cov 0.61
                               conf>=0.7 → acc 1.00 @ cov 0.30
                               conf>=0.9 → acc 1.00 @ cov 0.30
GC-2  rewards:                 genuine 1.0 | farmerBasic 0 | farmerSneaky 0
```

**Findings (sober):**
- **Blanket worded nudging is killed.** 61% average ⇒ ~40% of always-on nudges wrong; wrong-confident nudges are the costly, silently-followed failure mode. Do not ship always-on nudges.
- **Confidence-gating is the entire viability condition, and it works *on this data*.** The model is bimodal: ~30% of steps are high-confidence and near-perfect; the rest are correctly uncertain (the genuine `read → {createTask|write|updateTask}` branch points). ⇒ act only on the confident minority. This is a "fires occasionally, when sure" feature, not "always steering."
- **Success-weighting is a mild win (+3 pts), not the linchpin.** Earlier framing overstated it.
- **GC-2 is a correctness check, not a discovery** — the gate was designed to catch exactly that farmer pattern; its value is confirming provenance-spoofing doesn't bypass the same-session guard.
- **Synthetic caveat:** 100%@conf≥0.7 is optimistic vs real usage; the robust finding is the *shape* (confidence separates good predictions from bad), not the magnitudes. Untested here and needing real telemetry: causal-use measurability, per-user data sufficiency vs drift, prefetch+nudge anchoring interaction.

**Decision:** proceed **prefetch-only** (safe at any accuracy); treat the worded nudge as unproven — gate at conf≥~0.8, low coverage expected, A/B vs no-nudge on real data before trusting it.

## Design (if it survives Phase 0)

**The exploit/explore/inspect partition = the speculation-safety partition** (the load-bearing idea):

| Mode | axis | I/O | speculate? | steering treatment |
|------|------|-----|-----------|--------------------|
| **Inspect** (read/verify/deepen) | info-gain | read-only | yes, aggressively | silent prefetch |
| **Explore** (search/fan-out) | reward (distributional) | read-only | yes, when confident | silent prefetch |
| **Exploit** (create/update/commit) | reward (immediate) | **mutating** | **never** | worded nudge, high bar, all reward-guards |

Key decisions, each tied to evidence:
- **LLM proposes, a thin on-device learned ranker decides.** LLMs are weak explore/exploit arbiters but good candidate-proposers (Harris & Slivkins 2025; Krishnamurthy et al. NeurIPS 2024). Don't trust the model to self-steer.
- **Two-head scoring, not one.** `score = expected_success (exploit/explore) + λ·expected_info_gain (inspect)`. Inspect is an *uncertainty-reduction* objective (active learning / EIG), orthogonal to reward — don't collapse it into the reward number.
- **Predictor = success-weighted low-order Markov, primary; episodic retrieval of successful trajectories, fallback** (AutoTool 2025; Synapse ICLR 2024; ExpeL AAAI 2024; AWM ICML 2025). Episodic retrieval reuses the embedding adapter. Heavier methods (RL policy, LM workflow induction) starve on our data.
- **Prefetch ≠ nudge.** Prefetch is data (safe); nudge is persuasion (risky, asymmetric). Gate on **empirical transition success, not model confidence** (RLHF degrades calibration). Nudge bar > prefetch bar. Prefer silent prefetch over prose.
- **Debias the menu-pick** as semi-bandit feedback (DCM/SlateQ): exploration floor + IPS-weight by propensity + occasionally randomize order, or "what worked before" self-reinforces — the same loop we fought in retrieval.
- **Reward by independence + substance + causal-use.** Hard-zero (not soft-discount) agent-self-created same-session completions (current-RF optimization, Everitt et al.; Sycophancy→Subterfuge, Anthropic 2024). Provenance from an agent-unwritable channel. Highest-value: pay only for completions whose output is demonstrably used downstream (Proof-of-Use 2025).

## Phased plan (prefetch-first)

- **Phase 1 — silent schema/result prefetch for read-only predictions only.** The safe, high-value half. No persuasion. Reuses the dream-mined Markov predictor. Self-evaluating (hit = good, miss = cheap waste). Ship, measure hit-rate in telemetry.
- **Phase 2 — worded nudge for exploit transitions, behind a higher empirical-success bar, A/B against no-nudge.** Only if telemetry shows it's net-positive. Default off.
- **Reuse:** the `DreamConsolidationService` becomes a multi-learner engine; the predictor is another contestant/learner sharing `TraceFeedbackSource`. The reward-gating is shared with the retrieval task-completion signal.

## Threat model (steering-specific)

- **Reward tampering** (spawn/farm tasks) — Phase-0 GC-2; hard-zero + causal-use + provenance-from-unwritable-channel; standing adversarial red-team eval (RHB/EvilGenie style).
- **Over-steering** (wrong nudge followed silently) — gate on empirical success not model confidence; prefer prefetch; keep the discovery path open (verify-and-discard); log injected-vs-followed-vs-success to detect silent followership.
- **Self-confirmation** (nudge causes the behavior it predicts) — reward downstream success not compliance; counterfactual withholding; learn hardest from overrides; IPS-debias the pick.
- **Predictor as attack surface** (ToolTweak 2025) — validate any tool-author-supplied metadata feeding the predictor.

## Open questions
- Is per-user data volume sufficient before non-stationarity dominates? (Maybe pool across workspaces, or fall back to a slowly-updated global prior.)
- Can causal-use be measured reliably from existing traces, or does it need new capture?
- Does prefetch + nudge *compound* anchoring? Unstudied in the literature — must A/B prefetch-only vs prefetch+nudge in our own data.

## Sources (selected)
Speculative Actions (ICLR 2026) · PASTE (2026) · Speculative decoding, Leviathan 2023 · AutoTool 2025 · Synapse ICLR 2024 · ExpeL AAAI 2024 · AWM ICML 2025 · Harris & Slivkins 2025 (arXiv:2502.00225) · Krishnamurthy et al. NeurIPS 2024 · Pirolli & Card 1999 (Information Foraging) · Sutton/Precup/Singh 1999 (Options) · Horvitz 1999 (Mixed-Initiative) · Everitt et al. 2019/2021 (Reward Tampering CIDs) · Denison et al. 2024 (Sycophancy→Subterfuge) · Lightman et al. 2023 / Uesato et al. 2022 (process reward) · Proof-of-Use 2025 · "Unspoken Hints" 2025 · FlipFlop 2023 · DCM Bandits 2016 / SlateQ.
