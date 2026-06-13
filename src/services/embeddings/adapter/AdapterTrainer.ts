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
  /**
   * Relative importance of this example (default 1). The miner raises it for
   * task-completion-linked feedback — the strongest reward signal — so those
   * gradients count more without duplicating rows.
   */
  weight?: number;
}

/**
 * Training objective. All three share the SAME backprop into the low-rank
 * factors; they differ only in the per-candidate score gradient:
 *  - 'infonce': contrastive softmax (binary positive-vs-rest).
 *  - 'bpr':     pairwise logistic — used ≻ each skipped-above. Treats
 *               skip-above as PREFERENCES, not hard negatives (avoids the
 *               false-negative penalty InfoNCE imposes). [Rendle 2009]
 *  - 'kto':     Kahneman–Tversky prospect-theory loss with loss-aversion
 *               (undesirable losses loom larger than desirable gains).
 *               Reference point = in-example mean score. [Ethayarajh 2024,
 *               adapted: reference is a batch baseline, not a policy ratio.]
 */
export type TrainObjective = 'infonce' | 'bpr' | 'kto';

export interface TrainConfig {
  /** Which loss to optimize (default 'infonce'). */
  loss?: TrainObjective;
  /** Human-readable label for bake-off leaderboards. */
  label?: string;
  rank?: number;
  /** Blend/strength used in BOTH training and inference (kept consistent). */
  alpha?: number;
  epochs?: number;
  learningRate?: number;
  /** L2 pull toward identity (regularization coefficient). */
  l2?: number;
  /** Softmax temperature (InfoNCE). */
  temperature?: number;
  /** KTO: logit scale on cosine scores. */
  ktoBeta?: number;
  /** KTO: weight on desirable (used) examples. */
  ktoLambdaDesirable?: number;
  /** KTO: weight on undesirable (skipped) examples — > desirable encodes loss aversion. */
  ktoLambdaUndesirable?: number;
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
  loss: 'infonce' as TrainObjective,
  label: '',
  rank: 16,
  alpha: 1.0,
  epochs: 60,
  learningRate: 0.5,
  l2: 1e-3,
  temperature: 0.1,
  ktoBeta: 5,
  ktoLambdaDesirable: 1.0,
  ktoLambdaUndesirable: 1.33, // mild loss aversion (prospect theory)
  minExamples: 20,
  seed: 1,
  version: 1
};

type MergedConfig = typeof DEFAULTS;

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Per-candidate score gradient g_j = ∂L/∂score_j for the chosen objective.
 * Candidate 0 is the positive (used) item; 1..n-1 are skipped-above negatives.
 * `dot` are raw (untempered) similarity scores. Returns loss for monitoring.
 */
function objectiveGradients(dot: Float64Array, cfg: MergedConfig): { loss: number; g: Float64Array } {
  const n = dot.length;
  const g = new Float64Array(n);

  if (cfg.loss === 'bpr') {
    // Σ_j -log σ(s0 - sj):  used preferred over each skipped-above item.
    let loss = 0;
    for (let j = 1; j < n; j++) {
      const m = sigmoid(dot[0] - dot[j]);
      loss += -Math.log(Math.max(m, 1e-12));
      g[0] += -(1 - m);
      g[j] += (1 - m);
    }
    return { loss, g };
  }

  if (cfg.loss === 'kto') {
    // Prospect-theory value around an in-example reference point z (the mean
    // score). Desirable (used) should sit above z; undesirable below it.
    const beta = cfg.ktoBeta;
    let z = 0;
    for (let j = 0; j < n; j++) z += beta * dot[j];
    z /= n; // reference point (detached)

    let loss = 0;
    const v0 = sigmoid(beta * dot[0] - z);
    loss += cfg.ktoLambdaDesirable * (1 - v0);
    g[0] += -cfg.ktoLambdaDesirable * beta * v0 * (1 - v0);
    for (let j = 1; j < n; j++) {
      const uj = sigmoid(z - beta * dot[j]);
      loss += cfg.ktoLambdaUndesirable * (1 - uj);
      g[j] += cfg.ktoLambdaUndesirable * beta * uj * (1 - uj);
    }
    return { loss, g };
  }

  // 'infonce': softmax over s/τ; g_j = (1/τ)(p_j − y_j).
  const tau = cfg.temperature;
  let maxS = -Infinity;
  for (let j = 0; j < n; j++) if (dot[j] / tau > maxS) maxS = dot[j] / tau;
  let sumExp = 0;
  const p = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    p[j] = Math.exp(dot[j] / tau - maxS);
    sumExp += p[j];
  }
  for (let j = 0; j < n; j++) p[j] /= sumExp;
  for (let j = 0; j < n; j++) g[j] = (1 / tau) * (p[j] - (j === 0 ? 1 : 0));
  return { loss: -Math.log(Math.max(p[0], 1e-12)), g };
}

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
        const weight = examples[idx].weight ?? 1;
        epochLoss += AdapterTrainer.step(examples[idx], U, V, dim, rank, cfg, weight);
      }
      epochLoss /= order.length;
      if (epoch === 0) initialLoss = epochLoss;
      finalLoss = epochLoss;
    }

    const snapshot: AdapterSnapshot = {
      version: cfg.version,
      dim,
      rank,
      alpha: cfg.alpha,
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
    cfg: MergedConfig,
    weight: number
  ): number {
    const alpha = cfg.alpha;
    const lr = cfg.learningRate;
    const l2 = cfg.l2;
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

    // Raw similarity scores, then objective-specific per-candidate gradient.
    const dot = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      let acc = 0;
      const d = docs[j];
      for (let i = 0; i < dim; i++) acc += Wq[i] * d[i];
      dot[j] = acc;
    }
    const { loss, g: gScore } = objectiveGradients(dot, cfg);

    // Shared backprop into the low-rank factors (identical across objectives):
    // ∂score_j/∂U = α·d_j aᵀ ; ∂score_j/∂V = α·q (Uᵀd_j)ᵀ
    const gradU = zeros(dim, rank);
    const gradV = zeros(dim, rank);
    for (let j = 0; j < n; j++) {
      const g = weight * alpha * gScore[j];
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
