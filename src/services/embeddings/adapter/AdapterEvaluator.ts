/**
 * Location: src/services/embeddings/adapter/AdapterEvaluator.ts
 * Purpose: Held-out evaluation + promotion gate for the retrieval adapter.
 *
 * The dream job trains a candidate adapter on an older slice of feedback and
 * scores it here against a newer held-out slice. A new adapter is promoted
 * ONLY if it improves relevance (MRR) AND does not collapse diversity below a
 * coverage floor — so a model that "wins" by funneling every query to the same
 * few notes is rejected. Relevance and serendipity are both gates, by design.
 */

import type { QueryAdapter } from './EmbeddingAdapter';

export interface EvalCandidate {
  id: string;
  /** Unit-norm document embedding. */
  vec: Float32Array;
}

export interface EvalExample {
  /** Unit-norm query embedding. */
  query: Float32Array;
  candidates: EvalCandidate[];
  /** The id of the candidate that was actually used. */
  positiveId: string;
}

export interface EvalResult {
  /** Mean reciprocal rank of the used candidate. */
  mrr: number;
  /** recall@k for the requested k values. */
  recallAtK: Record<number, number>;
  /** Distinct candidates surfaced in top-k ÷ distinct candidates available. */
  coverage: number;
  examples: number;
}

export interface PromotionConfig {
  /** Minimum MRR improvement required to promote. */
  mrrMargin?: number;
  /** Minimum acceptable coverage for the new adapter. */
  coverageFloor?: number;
  /** k used for recall/coverage. */
  k?: number;
}

const DEFAULT_K = 5;

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export class AdapterEvaluator {
  /**
   * Rank each example's candidates by adapter score and aggregate MRR,
   * recall@k and coverage over the held-out set.
   */
  static evaluate(
    adapter: QueryAdapter,
    examples: EvalExample[],
    kValues: number[] = [1, 5]
  ): EvalResult {
    const ks = [...new Set(kValues)].sort((x, y) => x - y);
    const coverageK = ks[ks.length - 1] ?? DEFAULT_K;

    let reciprocalSum = 0;
    const recallHits: Record<number, number> = Object.fromEntries(ks.map(k => [k, 0]));
    const surfaced = new Set<string>();
    const allIds = new Set<string>();
    let counted = 0;

    for (const ex of examples) {
      if (ex.candidates.length === 0) continue;
      counted++;

      const q = adapter.transform(ex.query);
      const ranked = ex.candidates
        .map(c => ({ id: c.id, score: dot(q, c.vec) }))
        .sort((x, y) => y.score - x.score);

      for (const c of ex.candidates) allIds.add(c.id);

      const rank = ranked.findIndex(r => r.id === ex.positiveId) + 1; // 1-based; 0 ⇒ absent
      if (rank > 0) reciprocalSum += 1 / rank;

      for (const k of ks) {
        if (rank > 0 && rank <= k) recallHits[k] += 1;
      }
      for (let i = 0; i < Math.min(coverageK, ranked.length); i++) {
        surfaced.add(ranked[i].id);
      }
    }

    const recallAtK: Record<number, number> = {};
    for (const k of ks) recallAtK[k] = counted > 0 ? recallHits[k] / counted : 0;

    return {
      mrr: counted > 0 ? reciprocalSum / counted : 0,
      recallAtK,
      coverage: allIds.size > 0 ? surfaced.size / allIds.size : 0,
      examples: counted
    };
  }

  /**
   * Promote iff relevance improves by the margin AND coverage stays at/above
   * the floor. A coverage-collapsing "improvement" is rejected.
   */
  static shouldPromote(before: EvalResult, after: EvalResult, config: PromotionConfig = {}): boolean {
    const margin = config.mrrMargin ?? 0.01;
    const floor = config.coverageFloor ?? 0.5;
    return after.mrr >= before.mrr + margin && after.coverage >= floor;
  }
}
