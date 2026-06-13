import { AdapterTrainer, TrainingExample } from '../../src/services/embeddings/adapter/AdapterTrainer';
import { AdapterEvaluator, EvalExample } from '../../src/services/embeddings/adapter/AdapterEvaluator';
import { EmbeddingAdapter } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const swap = (v: Float32Array) => new Float32Array([v[1], v[0]]);

/**
 * Build a learnable task identity CANNOT solve: relevance is the axis-swap of
 * the query. Identity ranks the (non-swapped) distractor first; a rank-1
 * residual W = I + U·Vᵀ can represent the swap, so a correct trainer must beat
 * identity here.
 */
function makeSwapData(n: number, seed = 7): { train: TrainingExample[]; evalSet: EvalExample[] } {
  const r = rng(seed);
  const train: TrainingExample[] = [];
  const evalSet: EvalExample[] = [];
  for (let i = 0; i < n; i++) {
    const theta = r() * Math.PI * 2;
    const q = new Float32Array([Math.cos(theta), Math.sin(theta)]);
    const positive = swap(q);
    const negative = new Float32Array([q[0], q[1]]);
    train.push({ query: q, positive, negatives: [negative] });
    evalSet.push({
      query: q,
      candidates: [{ id: 'pos', vec: positive }, { id: 'neg', vec: negative }],
      positiveId: 'pos'
    });
  }
  return { train, evalSet };
}

describe('AdapterTrainer', () => {
  it('returns identity when there is too little data', () => {
    const { train } = makeSwapData(5);
    const { adapter, stats } = AdapterTrainer.train(train, { minExamples: 20 });
    expect(adapter.isIdentity).toBe(true);
    expect(stats.trained).toBe(false);
  });

  it('learns a transform identity cannot represent (beats identity MRR)', () => {
    const { train, evalSet } = makeSwapData(80, 11);

    const before = AdapterEvaluator.evaluate(EmbeddingAdapter.identity(2), evalSet);
    const { adapter, stats } = AdapterTrainer.train(train, {
      rank: 4, alpha: 1, epochs: 200, learningRate: 0.3, temperature: 0.1, minExamples: 20, seed: 3
    });
    const after = AdapterEvaluator.evaluate(adapter, evalSet);

    // Identity is forced to ~0.5 here; a working trainer pushes well past it.
    expect(before.mrr).toBeCloseTo(0.5, 1);
    expect(after.mrr).toBeGreaterThan(0.9);
    expect(adapter.isIdentity).toBe(false);
    expect(stats.trained).toBe(true);
  });

  it('drives the contrastive loss down over training', () => {
    const { train } = makeSwapData(80, 5);
    const { stats } = AdapterTrainer.train(train, {
      rank: 4, alpha: 1, epochs: 200, learningRate: 0.3, temperature: 0.1, minExamples: 20, seed: 3
    });
    expect(stats.finalLoss).toBeLessThan(stats.initialLoss);
    expect(stats.finalLoss).toBeLessThan(0.4); // below the log(2) ≈ 0.69 uniform baseline
  });

  it('learns the swap task under the BPR pairwise-preference objective', () => {
    const { train, evalSet } = makeSwapData(80, 13);
    const before = AdapterEvaluator.evaluate(EmbeddingAdapter.identity(2), evalSet);
    const { adapter } = AdapterTrainer.train(train, {
      loss: 'bpr', rank: 4, alpha: 1, epochs: 200, learningRate: 0.3, minExamples: 20, seed: 3
    });
    const after = AdapterEvaluator.evaluate(adapter, evalSet);
    expect(before.mrr).toBeCloseTo(0.5, 1);
    expect(after.mrr).toBeGreaterThan(0.9);
  });

  it('learns the swap task under the KTO (prospect-theory) objective', () => {
    const { train, evalSet } = makeSwapData(80, 17);
    const before = AdapterEvaluator.evaluate(EmbeddingAdapter.identity(2), evalSet);
    const { adapter } = AdapterTrainer.train(train, {
      loss: 'kto', rank: 4, alpha: 1, epochs: 400, learningRate: 0.5,
      ktoBeta: 4, ktoLambdaDesirable: 1, ktoLambdaUndesirable: 1.33, minExamples: 20, seed: 3
    });
    const after = AdapterEvaluator.evaluate(adapter, evalSet);
    expect(before.mrr).toBeCloseTo(0.5, 1);
    // KTO learns the right direction (well above identity's 0.5). It plateaus
    // below BPR/InfoNCE on this 2-candidate symmetric toy because its
    // mean-baseline signal is softer — exactly why a bake-off, not a fixed
    // objective, is the unbiased choice.
    expect(after.mrr).toBeGreaterThan(0.7);
  });
});
