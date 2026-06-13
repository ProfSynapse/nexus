# Implementation Plan: Self-Improving Local Retrieval Adapter ("Dreaming" Embeddings)

> Status: **PLANNED** — design doc, not yet implemented. — created 2026-06-13
> Branch: `claude/local-notes-embedding-model-x3hprj`
> Origin: research question — "train an embedding model on our notes through the lens of the tool calls that retrieve vault information (search + read), growing with usage, all local, low friction — like it occasionally *dreams*."

## Progress Log

| Date | Phase | Status | Notes |
|------|-------|--------|-------|
| 2026-06-13 | — | **PLANNED** | Design doc written. No code yet. Grounded against `ToolCallTraceService.ts`, `NoteEmbeddingService.ts`, `schema.ts:261`, `WorkflowScheduleService.ts`, `IndexingQueue.ts`. |

---

## Summary

We do **not** fine-tune the encoder. We keep `Xenova/all-MiniLM-L6-v2` frozen and learn a small **query-side linear adapter** `W` on top of it, supervised by the user's own retrieval behavior (which notes a `searchContent` returned, and which one got `read`/used next). A scheduled, idle-triggered **"dream" job** mines the trace log for these implicit-relevance pairs, trains `W` with a contrastive objective, validates it against held-out history, and promotes it only if it measurably improves retrieval on the user's own data. `W` is a few hundred KB, syncs through the existing event store, and is applied at exactly one line in `NoteEmbeddingService.semanticSearch`.

**Why an adapter, not a fine-tune.** A single user produces tens-to-low-hundreds of retrieval events per week. Fine-tuning a 22M-param transformer on that data overfits and is impractical to run locally; `transformers.js` is an inference runtime. A low-rank linear adapter is ~25K–150K params, trains with plain SGD in <1s in JS, and is the statistically correct tool at this data scale.

**Why query-side only.** The stored note vectors in `note_embeddings` are L2-normalized (mean-pool + L2 in the embedding iframe). If we apply `W` to the **query** and re-normalize, ranking by `vec_distance_l2(W·q̂, d)` is monotonic with `cosine(W·q̂, d)`. So:
- The `note_embeddings` vec0 table is **never re-embedded or rewritten** when `W` changes — the adapter lives entirely on the query side, applied at search time.
- `W` initialized to identity means **day 0 is byte-for-byte today's behavior** — zero regression risk on launch.

This is an asymmetric dual-tower setup (learned query tower, frozen document tower), which is standard in dense retrieval (DPR-style).

---

## Specialist Perspectives

### 📋 Preparation Phase

**Effort**: Low — the relevant surfaces are already mapped.

#### Findings from codebase research (verified)

| Fact | Location | Consequence |
|------|----------|-------------|
| Query is embedded then KNN'd at one site | `NoteEmbeddingService.ts:177-193` | Single apply point for `W`. |
| Stored note vectors are L2-normalized | embedding iframe (mean-pool + L2) | Query-side transform + renormalize is rank-equivalent to cosine. No doc re-embedding. |
| Vec0 tables, 384 dims | `schema.ts:261-349` (`note_embeddings`) | Adapter is 384×384 (or low-rank). |
| Traces capture tool **input** fully, **output** as success/error only | `ToolCallTraceService.ts:298-318` (`buildOutcomeMetadata`) | **THE GAP**: search candidate lists are discarded today → no labels. Phase 0 fixes this. |
| `ContentManager.read` records `path` | `read.ts` + `extractRelatedFiles` (`ToolCallTraceService.ts:418-462`) | The "used note" half of the label already exists. |
| Trace metadata has an index signature (zero-migration extra fields) | `TraceMetadata` (pinned CLAUDE.md gotcha), used at `ToolCallTraceService.ts:114` | Candidate lists can be added to trace metadata with no schema migration. |
| 60s interval scheduler + Obsidian `registerInterval` + catch-up policies | `WorkflowScheduleService.ts` | Reuse this shape for the dream job. |
| Idle-yielding, pausable, resumable background work | `IndexingQueue.ts` | Reuse this shape for training without jank. |
| Embeddings disabled on mobile | `EmbeddingService.ts:62` (`isEnabled = !Platform.isMobile`) | Training is desktop-only by inheritance; see Mobile note. |

#### Research tasks
- [x] Confirm single query-embed site for adapter application (`NoteEmbeddingService.ts:177`).
- [x] Confirm stored vectors are normalized (iframe pooling) → cosine/L2 monotonicity holds.
- [x] Confirm the trace output gap (candidates not persisted).
- [x] Confirm `read` captures the path (the positive label source).
- [ ] Decide synced-artifact location for `W` (see Key Decisions — adapter storage).

---

### 🏗️ Architecture Phase

**Effort**: Medium.

#### Data flow (end to end)

```
search/read tool calls
        │  (Phase 0: persist candidate list + retrievalGroupId in trace outcome)
        ▼
  memory_traces (JSONL source of truth + SQLite cache)
        │  (Dream job mines + joins: query → candidates → used)
        ▼
  retrieval_feedback  (derived, rebuildable SQLite table: q_emb, pos, negs[])
        │  (Dream job trains W via InfoNCE, validates on held-out slice)
        ▼
  adapter-vN.json  (synced artifact, few hundred KB, versioned)
        │  (loaded at startup; mobile reads, desktop reads+writes)
        ▼
  NoteEmbeddingService.semanticSearch:  q̂' = normalize(W · q̂)   ← single apply line
        │
        ▼
  vec_distance_l2(q̂', d)  — note_embeddings table UNCHANGED
```

#### Components Affected

| Component | Change | Notes |
|-----------|--------|-------|
| `ToolCallTraceService.ts` | **Modify** | Phase 0: extend `buildOutcomeMetadata` (or a new `buildRetrievalOutcome`) to persist a compact candidate list `{paths[], scores[]}` and a `retrievalGroupId` for retrieval tools (`searchManager_*`, semantic `searchContent`). Additive, zero-migration. |
| `src/services/embeddings/adapter/EmbeddingAdapter.ts` | **New** | Holds `W` (low-rank `U,V` or dense). `transform(Float32Array) → Float32Array` + renormalize. Identity when no adapter loaded. Pure math, no deps — mobile-safe. |
| `src/services/embeddings/adapter/AdapterStore.ts` | **New** | Load/save versioned `adapter-vN.json` under the synced root via `vault.adapter` + `resolveVaultRoot`. Last-writer-wins, version-guarded. |
| `src/services/embeddings/adapter/RetrievalFeedbackMiner.ts` | **New** | Reads `memory_traces`, joins search→read within a session/`retrievalGroupId`, emits `(query, positivePath, negativePaths[])`. Re-embeds query + candidate notes via existing `EmbeddingEngine` (cache-hit on note vectors). |
| `src/services/embeddings/adapter/AdapterTrainer.ts` | **New** | InfoNCE/triplet SGD over feedback. Identity init, L2-to-identity regularization, early stop. Returns candidate `W` + training stats. |
| `src/services/embeddings/adapter/AdapterEvaluator.ts` | **New** | Held-out replay: MRR/recall@k of `current W` vs `candidate W` on a validation slice. Promote only on improvement. |
| `src/services/dream/DreamConsolidationService.ts` | **New** | The scheduler. Idle-triggered (reuses `WorkflowScheduleService` interval + `registerInterval`). Orchestrates mine → train → eval → promote → report. Yields like `IndexingQueue`. |
| `NoteEmbeddingService.ts` | **Modify** | `semanticSearch`: after `generateEmbedding` (line 177), `queryEmbedding = adapter.transform(queryEmbedding)`. One line + injected adapter. |
| `EmbeddingService.ts` | **Modify** | Own the `EmbeddingAdapter` singleton; load on init; expose to `NoteEmbeddingService`. Guarded by `isEnabled`. |
| `schema.ts` | **Modify** | Add `retrieval_feedback` table (derived/rebuildable cache; bump `CURRENT_SCHEMA_VERSION`). Not synced. |
| Settings (`ProvidersTab`/embeddings section) | **Modify** | Toggle "Learn from my searches (Dreaming)", status line (last dream, examples learned, held-out lift), "Reset adapter" button. |
| `styles.css` | **Modify** | Minor — dream status row. |

#### The adapter math (concrete)

- **Shape**: low-rank `W = I + U·Vᵀ`, with `U,V ∈ ℝ^{384×r}`, `r ≈ 32–64`. (`I +` makes identity the zero-init and keeps the residual interpretation: the adapter only *adjusts* the base space.) Params ≈ `2·384·r` ≈ 25K–49K. Dense 384×384 (147K) is the fallback if low-rank underfits.
- **Apply** (query time): `q' = normalize((1−α)·q̂ + α·(I + U·Vᵀ)·q̂)`, with blend `α ∈ [0,1]` (default ~0.5). The adapter **nudges** the base geometry, it never fully overrides it — `α` is a continuous serendipity dial (see Serendipity section). `q̂` is the already-normalized MiniLM query vector. Renormalize so `vec_distance_l2` stays a monotone proxy for `cosine(q', d)`.
- **Train**: InfoNCE per example — positive `d⁺` (the used note's stored vector), negatives = the other returned candidates `d⁻` (hard negatives, free from the candidate list) ± a few random vault vectors. Loss = `−log[ exp(s⁺/τ) / Σ exp(s/τ) ]`, `s = cosine(q', d)`, temperature `τ ≈ 0.05`. Regularize `+λ·(‖U‖² + ‖V‖²)` to pull toward identity, **plus an anti-collapse term** `+β·‖WᵀW − I‖²` that penalizes the adapter for shrinking or flattening the space onto a few directions (near-isometry constraint — the literal "don't overfit the distribution" guard). Full-batch or mini-batch SGD, ~hundreds of epochs, <1s desktop.
- **Promote gate**: split feedback into train/validation by time. Train on the older slice; promote the new `W` only if held-out MRR (or recall@k) ≥ current `W` by a margin. Otherwise keep current. This is an automated A/B on the user's own behavior — the system can *prove* it helped before shipping itself.

#### 🎲 Serendipity & Exploration (the anti-overfit core, not a bolt-on)

The trained adapter is pure **exploitation** — it rewards what already worked. Two failure modes follow if that's all we ship: (1) a **filter bubble**, where the space collapses toward a few well-trodden clusters and novel-but-relevant notes get buried; and (2) a **starved training signal**, because the feedback log only ever contains candidates the *old* ranking surfaced — so the adapter can never discover useful regions it doesn't already favor. Exploration fixes both: it protects discovery *and* it is the engine that feeds the trainer off-distribution examples. We treat retrieval as an explicit explore/exploit problem.

**Mechanisms (layered):**

1. **Blend dial `α`** (apply path, above). `q' = (1−α)·q̂ + α·W·q̂`. At `α=0` the adapter is invisible; the default keeps the *base* MiniLM geometry half-intact so the learned bias can only tilt the field, never replace it. `α` is user-exposed ("how much should search lean on what it's learned").
2. **Wildcard slots (ε-exploration).** Reserve a small fraction of every result set (e.g. 1–2 of top-k, ε≈0.1–0.2) for candidates chosen by an **exploration policy** instead of adapted score: drawn from the *raw* un-adapted ranking, or from novelty/diversity picks (see below). Wildcards are silently logged as exploration; if one gets *used*, it becomes a high-value training example from outside the current distribution. This is the loop that keeps the adapter from eating its own tail.
3. **Novelty / "forgotten gems" picks.** The exploration slot can deliberately favor under-retrieved notes — long-tail, temporally distant, or rarely-surfaced — so old material resurfaces. This is the most on-theme part of the "dreaming" metaphor: dreams recombine **distant** memories, not adjacent ones.
4. **MMR diversity in assembly.** Re-rank the final list with Maximal Marginal Relevance (relevance − redundancy) so near-duplicate clusters don't crowd out a single novel note. Diversity is applied *after* adapted scoring, independent of `α`.
5. **Anti-collapse training term** (`β·‖WᵀW − I‖²`, in trainer above) keeps `W` close to an isometry — structurally forbids the "map everything to one corner" overfit.
6. **Coverage floor in the promotion gate.** The dream job promotes a new `W` only if it improves relevance (held-out MRR) **without** dropping a **diversity/coverage metric** below a floor (e.g. distinct notes surfaced across a replay set, or entropy of the retrieved-note distribution). A `W` that raises MRR by collapsing variety is **rejected** even though it "scores better." Serendipity is a first-class promotion constraint, not a tiebreaker.
7. **Recency-weighted feedback + drift-to-identity.** Old examples decay; a pattern that stops being reinforced lets the adapter relax back toward identity (the `λ` pull). Nothing ossifies permanently.

**Tuning the explore rate by data maturity:** high ε / low `α` when the feedback log is small (mostly explore — we know little), easing toward more exploitation as held-out lift becomes stable and statistically real. The system is humble when it's ignorant and confident only once its own A/B says so.

#### 🧭 Algorithmic lenses: Q-learning and A* (what to mimic, what to skip)

Retrieval-through-tool-calls is naturally a **sequential decision process**, not a one-shot lookup: you search, read a note, that reshapes the query, you search again. Two classic algorithms map onto it and each formalizes a different half of the serendipity problem. We **borrow ideas**, we don't import the full machinery.

**The shared framing (MDP).** State `s` = query/goal context (+ what's been read this session). Action `a` = surface/read a note. Reward `r` = usage (read/cited = +, ignored = 0/−) + a novelty bonus. The adapter's `cosine(W·q, d)` is already a parametric **value over (query, note) pairs** — i.e. a `Q(s,a)` function approximator. Seen this way, the contrastive trainer is a (supervised, one-step) special case of value learning, and the RL lens just tells us how to make it sequential and exploratory.

**Q-learning — borrow four ideas, skip the rest.**
1. **Experience replay = the dream itself.** DQN's replay buffer (store transitions, replay them in offline batches to stabilize learning) was *explicitly modeled on hippocampal replay during sleep*. The "dream" job **is** an experience-replay buffer with offline batch updates. This is the tightest conceptual match in the whole design — lean into it: the dream replays logged `(query, candidates, used)` transitions, not just the last session.
2. **ε-greedy exploration = the wildcard slots** (already in Serendipity §). Straight out of Q-learning; the serendipity dial and ε-greedy are the same lever.
3. **Intrinsic / curiosity reward = serendipity, formalized.** Count-based / RND-style exploration adds an *intrinsic* reward for visiting novel or under-retrieved states. That is exactly the "forgotten gems" bonus — so serendipity isn't a hack bolted next to the reward, it's a principled **`r = r_usage + κ·r_novelty`** term the trainer optimizes. This is the cleanest justification for the wildcard.
4. **Multi-step credit assignment (TD / Bellman).** Contrastive training treats each `(query→read)` as i.i.d. A retrieval *session* is a trajectory: a note that doesn't answer the task but **leads** to the note that does is a valuable *stepping stone*. TD backup `Q(s,a) ← r + γ·max_a' Q(s',a')` propagates terminal task-success reward back to those intermediate retrievals. Reward good bridges, not just good destinations — very on-theme for sequential tool-call retrieval.

   **Skip:** full online/tabular Q-learning (action space = whole vault, intractable) and naïve offline RL (our data is small, off-policy, prone to extrapolation error). Stay in **behavior-regularized / conservative** territory — which we already are: blend `α`, regularize-to-identity, and only ever score `Q` over the *returned candidate set*, never the full vault. So this is **fitted-Q over logged candidates**, conservative by construction — not a DQN rabbit hole.

**A* — the structural complement to stochastic serendipity.**
Pure KNN is "heuristic-only, no graph": it teleports to whatever's nearest in embedding space. A* adds **path cost + graph structure**, which is the serendipity-through-*structure* that ε-greedy can't give you. Mapping:
- Nodes = notes; **edges = Obsidian wiki-links + semantic neighbors** (Nexus already extracts wiki-links in `EmbeddingUtils` and reference-boosts on them).
- `g(n)` = traversal cost so far (hops / dissimilarity crossed). `h(n)` = **the learned adapter distance** from `n` to the goal — i.e. **`W` is literally the A* heuristic function**. The same matrix that's the Q-value is the search heuristic.
- A* does best-first frontier expansion minimizing `g + h`, chaining hops until the info-need is met — finding notes that aren't *directly* similar to the query but are reachable via a meaningful chain. That's multi-hop "connect distant ideas" retrieval.

   **Honest caveat:** the "goal" in retrieval is a fuzzy info-need, not a known target node, and a learned `h` isn't provably admissible — so A*'s optimality guarantee does **not** hold. What we actually adopt is **A*-flavored best-first / beam graph search** guided by the adapter heuristic. Still very useful; just not textbook-optimal.

   **Where it runs:** graph traversal costs more than one KNN, so it's not every keystroke. Its home is **dream-time**: run beam/A* search over the note graph offline to surface non-obvious multi-hop bridges ("these two notes you never linked are 3 hops apart and semantically converging") — a serendipitous *dream output* the user wakes up to. Optionally exposed as a "deep search" mode at query time.

**How the three compose.** The contrastive **adapter** learns the *metric* (cheap, supervised, the workhorse). **Q-learning ideas** shape *how it learns* — replay (= dreaming), intrinsic novelty reward (= serendipity), multi-step credit (= stepping-stone notes), ε-greedy (= wildcards). **A*/best-first** uses that metric as a *heuristic to plan paths* through the wiki-link graph, adding structural serendipity. Serendipity therefore enters twice and from independent directions: **stochastically** (ε-greedy + curiosity reward, the Q side) and **structurally** (multi-hop bridges, the A* side) — which is exactly the hedge against overfitting to one notion of "surprise."

**Adoption tiering (don't build it all at once):**
- **Now (in the 4 PRs):** ε-greedy wildcards + intrinsic novelty reward + experience-replay-shaped dream. These are cheap and directly serve the already-planned adapter.
- **Next:** multi-step credit assignment over sessions (needs the `retrievalGroupId` trajectory from Phase 0 — it's already being captured).
- **Later / experimental:** A* best-first graph search as a dream-time bridge-finder, then optionally a query-time "deep search" mode.

#### Phase 0 capture shape (the enabler)

In the retrieval tool's trace outcome (additive, lives in `metadataJson` via the index signature):

```jsonc
"outcome": {
  "success": true,
  "retrieval": {
    "groupId": "rg_<uuid>",          // ties this search to follow-up reads in the session
    "candidates": [                   // capped (e.g. top 10), paths + scores only
      { "path": "Notes/Foo.md", "score": 0.31 },
      { "path": "Notes/Bar.md", "score": 0.42 }
    ]
  }
}
```

The **label** is derived later, not captured inline: at dream time, a `read` (or cite) of a candidate `p` within the same session/`groupId` ⇒ positive `(query, p)`; the other candidates ⇒ negatives. Minimal capture surface; labels are mined.

#### Key Decisions

| Decision | Options | Resolution | Rationale |
|----------|---------|------------|-----------|
| What learns | encoder fine-tune / query-side adapter / reranker-only | **Query-side adapter** | Data-efficient, local-feasible, no doc re-embed, identity-safe. |
| Adapter form | dense 384² / low-rank `I+UVᵀ` | **Low-rank residual** (r≈32–64), dense fallback | Fewer params → less overfit on small data; identity init is free. |
| Where `W` applies | query side / both towers | **Query side only** | `note_embeddings` never rewritten on update — the friction win. |
| Label source | explicit thumbs / implicit read-follow | **Implicit** (search→read join) | Zero user friction; `read` path already traced. |
| Candidate capture | new feedback event / extend trace outcome | **Extend trace outcome** (index-sig, zero-migration) | Reuses `memory_traces`; mining builds the derived table. |
| `retrieval_feedback` table | synced / local cache | **Local rebuildable cache** | Derivable from JSONL traces; matches "SQLite = rebuildable" architecture. |
| `W` storage | SQLite (local) / synced versioned JSON file | **Synced `adapter-vN.json`** under `resolveVaultRoot(...)/data/embeddings/` | SQLite never syncs; `W` must reach other devices. Versioned + last-writer-wins (skills-mirror precedent). |
| Promotion | always replace / validate-then-promote | **Validate-then-promote** on held-out MRR **+ coverage floor** | Monotonic non-regression *and* serendipity preserved; auto-A/B on own data. |
| Adapter strength | full replace / blended nudge | **Blend `α` (default ~0.5)** | Base geometry never fully overridden; `α` is the serendipity dial. |
| Exploration | exploit-only / wildcard slots | **ε-exploration slots** (raw + novelty picks) | Prevents filter bubble; feeds off-distribution training signal. |
| Result diversity | rank by score / MMR | **MMR re-rank** in assembly | Novel notes survive near-duplicate clusters. |
| Anti-collapse | identity-reg only / + isometry term | **`β·‖WᵀW−I‖²`** | Structurally forbids variance-collapsing overfit. |
| Trigger | fixed cron / idle-triggered | **Idle-triggered** via existing interval | "Dream" feel; no UI jank; reuses `WorkflowScheduleService`. |
| Min data | train always / threshold | **≥ N examples (e.g. 50)** before first train | Below threshold, stay identity. |
| Kill switch | — | **Setting toggle + "Reset adapter" → identity** | Instant, total revert. |

#### Interface Contracts (sketch)

```typescript
// EmbeddingAdapter.ts — pure, mobile-safe, no Node deps
export class EmbeddingAdapter {
  static identity(dim: number): EmbeddingAdapter;
  static fromJSON(json: AdapterSnapshot): EmbeddingAdapter;
  get version(): number;
  get isIdentity(): boolean;
  transform(query: Float32Array): Float32Array; // returns normalized q'
  toJSON(): AdapterSnapshot;                     // { version, dim, rank, U, V, trainedAt, stats }
}

// RetrievalFeedbackMiner.ts
interface FeedbackExample { query: string; positivePath: string; negativePaths: string[]; ts: number; }
mine(sinceTs: number): Promise<FeedbackExample[]>;

// AdapterTrainer.ts
train(base: EmbeddingAdapter, data: FeedbackExample[], cfg: TrainConfig): Promise<{ adapter: EmbeddingAdapter; stats: TrainStats }>;

// AdapterEvaluator.ts
evaluate(adapter: EmbeddingAdapter, holdout: FeedbackExample[]): Promise<{ mrr: number; recallAtK: Record<number, number>; coverage: number }>;
// promote iff: mrrAfter ≥ mrrBefore + margin  AND  coverageAfter ≥ coverageFloor

// DreamConsolidationService.ts
start(): void;              // registerInterval; idle-gated
runDreamCycle(): Promise<DreamReport>; // mine → train → eval → promote → persist
interface DreamReport { newExamples: number; explorationHits: number; mrrBefore: number; mrrAfter: number; coverageBefore: number; coverageAfter: number; promoted: boolean; }
```

---

### 🧪 Testing Phase

**Effort**: Medium.

- **EmbeddingAdapter**: identity transform == input (renormalized); known `U,V` produces expected rotation; serialization round-trip; dimension guard.
- **Phase 0 capture**: a semantic `searchContent` trace persists `retrieval.candidates` + `groupId`; non-retrieval tools unaffected; candidate cap respected; `metadataJson` parses.
- **Miner**: synthetic trace stream (search then read of candidate B) yields `(query, B, [A,C])`; no read ⇒ no example; cross-session reads don't leak.
- **Trainer**: on a separable synthetic set, post-train held-out MRR > identity; identity-init + zero data ⇒ returns identity; regularization keeps `‖W−I‖` bounded.
- **Evaluator/promotion**: a `W` that worsens held-out MRR is **not** promoted; the better one is.
- **Apply site**: `semanticSearch` with identity adapter returns byte-identical ranking to pre-change (regression guard via counter-test).
- **Mobile**: `EmbeddingAdapter` imports nothing Node; `AdapterStore` loads via `vault.adapter`; training services are desktop-gated and never constructed on mobile.

---

### ⚠️ Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Overfitting on tiny data | Low-rank + L2-to-identity + min-data threshold + validate-then-promote. |
| Filter bubble / distribution collapse | Blend `α` + ε-exploration wildcards + MMR + anti-collapse term + coverage-floor promotion gate (see Serendipity section). |
| Silent retrieval regression | Identity init; held-out promotion gate; one-click reset; counter-test on apply site. |
| Feedback noise (agent reads a wrong candidate) | Hard negatives are only *other returned candidates*; promotion gate filters net-harmful updates; recency-weighted feedback. |
| Sync conflict on `W` | Versioned filename + last-writer-wins; `W` is derivable (re-trainable) so a lost update self-heals next dream. |
| Background jank | Idle-trigger + `IndexingQueue`-style yielding; cap epochs/time per cycle. |
| Mobile breakage | Adapter math is dependency-free; all training desktop-gated; mobile loads `W` read-only. |
| Cold start (no `W` yet) | Identity until ≥N examples — behaves exactly like today. |

---

## Mobile note (honest scope)

Today the adapter **only affects desktop semantic search**, because mobile has no query encoder (`EmbeddingService.isEnabled = !Platform.isMobile`) — there's no query vector to transform. The synced-`W` design is forward-looking: if/when mobile semantic search lands, it inherits the learned adapter for free with no extra work. Do not market a mobile benefit until then.

---

## PR Slicing

- **PR1 — Phase 0 (enabler).** Persist retrieval candidates + `retrievalGroupId` in the trace outcome for semantic retrieval tools. Pure capture; useful as search analytics even if nothing else ships. Tests for capture shape. *Low risk, independently valuable.*
- **PR2 — Adapter apply path (identity).** `EmbeddingAdapter` + `AdapterStore` + wire into `NoteEmbeddingService.semanticSearch` and `EmbeddingService`, shipping **identity** `W`. Counter-test proves zero behavior change. Ships the machinery dark. *No behavior change on merge.*
- **PR3 — Miner + Trainer + Evaluator.** `retrieval_feedback` table (schema bump), mining join, InfoNCE trainer, held-out evaluator. Unit-tested offline; not yet scheduled. *No user-facing change.*
- **PR4 — Dream job + Settings.** `DreamConsolidationService` (idle-triggered), promotion + persist, settings toggle/status/reset. The feature goes live behind an opt-in toggle. *Activation PR.*

## Optional bolt-on (same machinery): learned reranker

The hardcoded rerank weights in `NoteEmbeddingService.semanticSearch:204-224` (recency 15%, path-match 10/20%) can be **learned** from the exact same feedback log via logistic regression — ~10 floats, mobile-safe arithmetic. Not in scope for the four PRs above, but the dream job and feedback table serve it with no new infrastructure. Track as a follow-up.

## Explicitly out of scope (future / "north star")

True local encoder fine-tune (updating MiniLM weights) — needs a training-capable runtime (ONNX Runtime training session or a desktop-only ML sidecar), thousands of accumulated examples, and full-vault re-embedding on every model change. Revisit only after the adapter demonstrably saturates over months of use.
