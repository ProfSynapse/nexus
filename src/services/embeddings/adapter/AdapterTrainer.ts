/**
 * Location: src/services/embeddings/adapter/AdapterTrainer.ts
 * Purpose: Train the query-side embedding adapter from retrieval feedback.
 *
 * Objective: contrastive InfoNCE over the residual transform W = I + α·U·Vᵀ.
 * For a query q (unit), a used "positive" doc d⁺ and ignored "negative" docs
 * d⁻ (all unit, frozen document vectors), we pull W·q toward d⁺ and away from
 * the d⁻. Scores are dot products during training (the inference renormalize
 * is rank-preserving), which keeps the gradients clean:
 *
 *   a   = Vᵀ·q                       (rank-dim)
 *   Wq  = q + α·U·a
 *   sⱼ  = Wq · dⱼ
 *   pⱼ  = softmax(s/τ)ⱼ
 *   L   = −log p₊                    (+ L2 pull toward identity)
 *   ∂L/∂U = (α/τ)·Σⱼ (pⱼ − yⱼ)·dⱼ aᵀ
 *   ∂L/∂V = (α/τ)·Σⱼ (pⱼ − yⱼ)·q (Uᵀdⱼ)ᵀ
 *
 * Identity-initialized (U=V≈0 ⇒ W≈I), so early training barely perturbs the
 * base space; the L2 term keeps it from drifting far without strong evidence.
 *
 * Pure / mobile-safe: operates on in-memory vectors, no IO. (Desktop gates
 * live at the call site, since embeddings are desktop-only.)
 */

import { EmbeddingAdapter, type AdapterSnapshot } from './EmbeddingAdapter';

export interface TrainingExample {
  /** Unit-norm query embedding. */
  query: Float32Array;
  /** Unit-norm embedding of the used (positive) candidate. */
  positive: Float32Array;
  /** Unit-norm embeddings of returned-but-ignored (negative) candidates. */
  negatives: Float32Array[];
}

export interface TrainConfig {
  rank?: number;
  /** Blend/strength used in BOTH training and inference (kept consistent). */
  alpha?: number;
  epochs?: number;
  learningRate?: number;
  /** L2 pull toward identity (regularization coefficient). */
  l2?: number;
  /** Softmax temperature. */
  temperature?: number;
  /** Below this many examples, return identity (don't train on noise). */
  minExamples?: number;
  /** Seed for reproducible factor init. */
  seed?: number;
  /** Version stamped on the produced adapter. */
  version?: number;
}

export interface TrainStats {
  trained: boolean;
  examples: number;
  epochs: number;
  initialLoss: number;
  finalLoss: number;
}

export interface TrainResult {
  adapter: EmbeddingAdapter;
  stats: TrainStats;
}

const DEFAULTS = {
  rank: 16,
  alpha: 1.0,
  epochs: 60,
  learningRate: 0.5,
  l2: 1e-3,
  temperature: 0.1,
  minExamples: 20,
  seed: 1,
  version: 1
};

/** Deterministic small PRNG (mulberry32) for reproducible init. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function zeros(rows: number, cols: number): number[][] {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

export class AdapterTrainer {
  /**
   * Train an adapter from feedback. Returns identity when there is too little
   * data to learn from responsibly.
   */
  static train(data: TrainingExample[], config: TrainConfig = {}): TrainResult {
    const cfg = { ...DEFAULTS, ...config };
    const examples = data.filter(e => e.query.length > 0 && e.positive.length === e.query.length);

    if (examples.length < cfg.minExamples) {
      return {
        adapter: EmbeddingAdapter.identity(examples[0]?.query.length || undefined),
        stats: { trained: false, examples: examples.length, epochs: 0, initialLoss: 0, finalLoss: 0 }
      };
    }

    const dim = examples[0].query.length;
    const rank = cfg.rank;
    const alpha = cfg.alpha;
    const tau = cfg.temperature;

    // Identity-ish init: tiny random factors so W ≈ I.
    const rand = mulberry32(cfg.seed);
    const U = zeros(dim, rank);
    const V = zeros(dim, rank);
    for (let i = 0; i < dim; i++) {
      for (let k = 0; k < rank; k++) {
        U[i][k] = (rand() - 0.5) * 0.02;
        V[i][k] = (rand() - 0.5) * 0.02;
      }
    }

    const order = examples.map((_, i) => i);
    let initialLoss = 0;
    let finalLoss = 0;

    for (let epoch = 0; epoch < cfg.epochs; epoch++) {
      // Fisher–Yates shuffle for SGD.
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }

      let epochLoss = 0;
      for (const idx of order) {
        epochLoss += AdapterTrainer.step(examples[idx], U, V, dim, rank, alpha, tau, cfg.learningRate, cfg.l2);
      }
      epochLoss /= order.length;
      if (epoch === 0) initialLoss = epochLoss;
      finalLoss = epochLoss;
    }

    const snapshot: AdapterSnapshot = {
      version: cfg.version,
      dim,
      rank,
      alpha,
      U,
      V,
      trainedAt: Date.now()
    };

    return {
      adapter: EmbeddingAdapter.fromSnapshot(snapshot),
      stats: { trained: true, examples: examples.length, epochs: cfg.epochs, initialLoss, finalLoss }
    };
  }

  /**
   * One SGD step on a single example; mutates U/V in place. Returns the
   * example's InfoNCE loss (before the update) for monitoring.
   */
  private static step(
    ex: TrainingExample,
    U: number[][],
    V: number[][],
    dim: number,
    rank: number,
    alpha: number,
    tau: number,
    lr: number,
    l2: number
  ): number {
    const q = ex.query;
    const docs = [ex.positive, ...ex.negatives.filter(n => n.length === dim)];
    const n = docs.length;
    if (n < 2) {
      return 0; // need at least one negative to contrast
    }

    // a = Vᵀ q  (rank-dim)
    const a = new Float64Array(rank);
    for (let k = 0; k < rank; k++) {
      let acc = 0;
      for (let i = 0; i < dim; i++) acc += V[i][k] * q[i];
      a[k] = acc;
    }

    // Wq = q + α·U·a  (dim)
    const Wq = new Float64Array(dim);
    for (let i = 0; i < dim; i++) {
      let delta = 0;
      const row = U[i];
      for (let k = 0; k < rank; k++) delta += row[k] * a[k];
      Wq[i] = q[i] + alpha * delta;
    }

    // scores + softmax over s/τ
    const s = new Float64Array(n);
    let maxS = -Infinity;
    for (let j = 0; j < n; j++) {
      let dot = 0;
      const d = docs[j];
      for (let i = 0; i < dim; i++) dot += Wq[i] * d[i];
      s[j] = dot / tau;
      if (s[j] > maxS) maxS = s[j];
    }
    let sumExp = 0;
    const p = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      p[j] = Math.exp(s[j] - maxS);
      sumExp += p[j];
    }
    for (let j = 0; j < n; j++) p[j] /= sumExp;

    const loss = -Math.log(Math.max(p[0], 1e-12)); // positive is index 0

    // g_j = (1/τ)(p_j − y_j); Uᵀd_j precomputed per candidate
    // ∂L/∂U += α·g_j·(d_j aᵀ) ; ∂L/∂V += α·g_j·(q (Uᵀd_j)ᵀ)
    const gradU = zeros(dim, rank);
    const gradV = zeros(dim, rank);
    for (let j = 0; j < n; j++) {
      const g = (alpha / tau) * (p[j] - (j === 0 ? 1 : 0));
      if (g === 0) continue;
      const d = docs[j];

      // Uᵀ d_j  (rank)
      const Utd = new Float64Array(rank);
      for (let k = 0; k < rank; k++) {
        let acc = 0;
        for (let i = 0; i < dim; i++) acc += U[i][k] * d[i];
        Utd[k] = acc;
      }

      for (let i = 0; i < dim; i++) {
        const gdi = g * d[i];
        const gqi = g * q[i];
        const gu = gradU[i];
        const gv = gradV[i];
        for (let k = 0; k < rank; k++) {
          gu[k] += gdi * a[k];
          gv[k] += gqi * Utd[k];
        }
      }
    }

    // SGD update with L2 pull toward identity (U,V → 0 ⇒ W → I)
    for (let i = 0; i < dim; i++) {
      const ui = U[i];
      const vi = V[i];
      const gu = gradU[i];
      const gv = gradV[i];
      for (let k = 0; k < rank; k++) {
        ui[k] -= lr * (gu[k] + l2 * ui[k]);
        vi[k] -= lr * (gv[k] + l2 * vi[k]);
      }
    }

    return loss;
  }
}
