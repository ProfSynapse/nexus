/**
 * Location: src/services/embeddings/adapter/DreamConsolidationService.ts
 * Purpose: The "dream" — offline consolidation of retrieval feedback into a
 * better adapter, à la experience replay during sleep.
 *
 * One cycle: mine feedback → split older/newer → train a candidate adapter on
 * the older slice → evaluate current vs candidate on the held-out newer slice
 * → promote ONLY on a relevance gain that holds the coverage floor → persist +
 * apply. A cycle that doesn't clear the bar leaves the live adapter untouched,
 * so retrieval never regresses from a bad night's sleep.
 *
 * Fully dependency-injected (trace source, embeddings, store, apply callback),
 * so the whole loop is testable with fake embeddings and no Obsidian runtime.
 */

import { EmbeddingAdapter } from './EmbeddingAdapter';
import { AdapterTrainer, TrainConfig } from './AdapterTrainer';
import { AdapterEvaluator, EvalResult, PromotionConfig } from './AdapterEvaluator';
import {
  RetrievalFeedbackMiner,
  RetrievalTraceRecord,
  FeedbackEmbeddingProvider,
  MinedExample,
  MineConfig,
  toTrainingExample,
  toEvalExample
} from './RetrievalFeedbackMiner';

export interface AdapterPersistence {
  load(): Promise<EmbeddingAdapter>;
  save(adapter: EmbeddingAdapter): Promise<void>;
}

export interface DreamConfig {
  /** Fraction of (time-ordered) examples held out for evaluation. */
  holdoutFraction?: number;
  /** Don't run a cycle below this many mined examples. */
  minExamples?: number;
  /** Don't promote unless the held-out set is at least this big (anti-noise). */
  minHoldout?: number;
  /** Single training config (used when `contestants` is not set). */
  train?: TrainConfig;
  /**
   * Bake-off: train each config on the same data and let the best beat the
   * incumbent. This is how we pick an objective (InfoNCE vs BPR vs KTO …)
   * empirically per user, instead of by prior belief.
   */
  contestants?: TrainConfig[];
  /** Extra MRR margin added per doubling of contestant count (winner's-curse guard). */
  comparisonPenalty?: number;
  promotion?: PromotionConfig;
  mine?: MineConfig;
}

/** One contestant's held-out scoreboard line. */
export interface LeaderboardEntry {
  label: string;
  loss: string;
  mrr: number;
  coverage: number;
  trained: boolean;
}

export interface DreamDeps {
  /** Pull the trace records to mine (prod: query memory_traces). */
  getTraceRecords: () => Promise<RetrievalTraceRecord[]>;
  embeddings: FeedbackEmbeddingProvider;
  store: AdapterPersistence;
  /** Apply a promoted adapter to the live search path (prod: setAdapter). */
  applyAdapter: (adapter: EmbeddingAdapter) => void;
  config?: DreamConfig;
}

export interface DreamReport {
  ranAt: number;
  minedExamples: number;
  trained: boolean;
  promoted: boolean;
  mrrBefore: number;
  mrrAfter: number;
  coverageBefore: number;
  coverageAfter: number;
  /** Per-contestant held-out scores, best first. */
  leaderboard?: LeaderboardEntry[];
  /** Label of the promoted contestant, if any. */
  winner?: string;
  reason?: string;
}

const DEFAULTS = { holdoutFraction: 0.25, minExamples: 20, minHoldout: 8, comparisonPenalty: 0.01 };

export class DreamConsolidationService {
  private running = false;

  constructor(private readonly deps: DreamDeps) {}

  /** Run one consolidation cycle. Safe to call repeatedly; self-coalesces. */
  async runDreamCycle(): Promise<DreamReport> {
    const base: DreamReport = {
      ranAt: Date.now(), minedExamples: 0, trained: false, promoted: false,
      mrrBefore: 0, mrrAfter: 0, coverageBefore: 0, coverageAfter: 0
    };

    if (this.running) {
      return { ...base, reason: 'already-running' };
    }
    this.running = true;
    try {
      const cfg = { ...DEFAULTS, ...this.deps.config };

      const records = await this.deps.getTraceRecords();
      const miner = new RetrievalFeedbackMiner(this.deps.embeddings, cfg.mine);
      const mined = await miner.mine(records);
      base.minedExamples = mined.length;

      if (mined.length < cfg.minExamples) {
        return { ...base, reason: 'insufficient-data' };
      }

      // Time-ordered split: train on the older slice, validate on the newer.
      mined.sort((a, b) => a.timestamp - b.timestamp);
      const holdoutCount = Math.max(1, Math.floor(mined.length * cfg.holdoutFraction));
      const trainSlice = mined.slice(0, mined.length - holdoutCount);
      const holdoutSlice = mined.slice(mined.length - holdoutCount);

      if (trainSlice.length < cfg.minExamples) {
        return { ...base, reason: 'insufficient-train-data' };
      }

      const holdoutEval = holdoutSlice.map(toEvalExample);
      const trainExamples = trainSlice.map(toTrainingExample);
      const current = await this.deps.store.load();
      const before = AdapterEvaluator.evaluate(current, holdoutEval);

      // ---- Bake-off: train every contestant on the SAME data, score on the
      // SAME held-out slice, best-that-clears-the-coverage-floor wins. ----
      const contestants: TrainConfig[] =
        cfg.contestants && cfg.contestants.length > 0 ? cfg.contestants : [cfg.train ?? {}];
      const coverageFloor = cfg.promotion?.coverageFloor ?? 0.5;
      const nextVersion = (current.version || 0) + 1;

      const leaderboard: LeaderboardEntry[] = [];
      let best: { adapter: EmbeddingAdapter; result: EvalResult; label: string } | null = null;

      for (let i = 0; i < contestants.length; i++) {
        const contestant = contestants[i];
        const trained = AdapterTrainer.train(trainExamples, {
          minExamples: cfg.minExamples,
          version: nextVersion,
          ...contestant
        });
        const score = AdapterEvaluator.evaluate(trained.adapter, holdoutEval);
        const label = contestant.label || contestant.loss || `contestant-${i}`;
        leaderboard.push({
          label, loss: contestant.loss ?? 'infonce',
          mrr: score.mrr, coverage: score.coverage, trained: trained.stats.trained
        });
        // Eligible only if it actually trained and didn't collapse diversity.
        if (trained.stats.trained && score.coverage >= coverageFloor &&
            (!best || score.mrr > best.result.mrr)) {
          best = { adapter: trained.adapter, result: score, label };
        }
      }
      leaderboard.sort((a, b) => b.mrr - a.mrr);

      // Winner's-curse guard: picking the max over K noisy contestants inflates
      // the apparent gain, so the bar to beat the incumbent rises with K.
      const baseMargin = cfg.promotion?.mrrMargin ?? 0.01;
      const effectiveMargin = baseMargin + cfg.comparisonPenalty * Math.log2(Math.max(1, contestants.length));
      const enoughHoldout = before.examples >= cfg.minHoldout;

      const promoted = !!best && enoughHoldout &&
        AdapterEvaluator.shouldPromote(before, best.result, { ...cfg.promotion, mrrMargin: effectiveMargin });

      if (promoted && best) {
        await this.deps.store.save(best.adapter);
        this.deps.applyAdapter(best.adapter);
      }

      const after = best ? best.result : before;
      const anyTrained = leaderboard.some(e => e.trained);
      return {
        ...this.report(base, mined, anyTrained, promoted, before, after),
        leaderboard,
        winner: promoted && best ? best.label : undefined
      };
    } finally {
      this.running = false;
    }
  }

  private report(
    base: DreamReport,
    mined: MinedExample[],
    trained: boolean,
    promoted: boolean,
    before: EvalResult,
    after: EvalResult
  ): DreamReport {
    return {
      ...base,
      minedExamples: mined.length,
      trained,
      promoted,
      mrrBefore: before.mrr,
      mrrAfter: after.mrr,
      coverageBefore: before.coverage,
      coverageAfter: after.coverage,
      reason: promoted ? 'promoted' : 'rejected'
    };
  }
}
