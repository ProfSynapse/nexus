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
  train?: TrainConfig;
  promotion?: PromotionConfig;
  mine?: MineConfig;
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
  reason?: string;
}

const DEFAULTS = { holdoutFraction: 0.25, minExamples: 20, minHoldout: 8 };

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
      const current = await this.deps.store.load();
      const before = AdapterEvaluator.evaluate(current, holdoutEval);

      const trained = AdapterTrainer.train(
        trainSlice.map(toTrainingExample),
        { minExamples: cfg.minExamples, ...cfg.train }
      );
      const after = AdapterEvaluator.evaluate(trained.adapter, holdoutEval);

      // Don't promote on a held-out set too small for the MRR delta to be real
      // signal rather than noise (a thin-data Goodhart guard).
      const enoughHoldout = before.examples >= cfg.minHoldout;
      const promoted = trained.stats.trained && enoughHoldout &&
        AdapterEvaluator.shouldPromote(before, after, cfg.promotion);

      if (promoted) {
        await this.deps.store.save(trained.adapter);
        this.deps.applyAdapter(trained.adapter);
      }

      return this.report(base, mined, trained.stats.trained, promoted, before, after);
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
