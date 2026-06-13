import { AdapterEvaluator, EvalExample, EvalResult } from '../../src/services/embeddings/adapter/AdapterEvaluator';
import { EmbeddingAdapter } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

const identity = EmbeddingAdapter.identity(2);

describe('AdapterEvaluator.evaluate', () => {
  it('computes MRR and recall@1 from candidate rankings', () => {
    const examples: EvalExample[] = [
      {
        query: new Float32Array([1, 0]),
        candidates: [{ id: 'p', vec: new Float32Array([1, 0]) }, { id: 'n', vec: new Float32Array([0, 1]) }],
        positiveId: 'p' // ranks #1 → reciprocal 1
      },
      {
        query: new Float32Array([1, 0]),
        candidates: [{ id: 'p', vec: new Float32Array([1, 0]) }, { id: 'n', vec: new Float32Array([0, 1]) }],
        positiveId: 'n' // ranks #2 → reciprocal 0.5
      }
    ];

    const result = AdapterEvaluator.evaluate(identity, examples, [1, 5]);

    expect(result.mrr).toBeCloseTo(0.75, 5);
    expect(result.recallAtK[1]).toBeCloseTo(0.5, 5);
    expect(result.coverage).toBeCloseTo(1, 5); // both candidates surfaced in top-5
  });

  it('detects diversity collapse via coverage at small k', () => {
    // Every query funnels to the same top-1 ('x'); y and z never surface.
    const candidates = [
      { id: 'x', vec: new Float32Array([1, 0]) },
      { id: 'y', vec: new Float32Array([0, 1]) },
      { id: 'z', vec: new Float32Array([-1, 0]) }
    ];
    const examples: EvalExample[] = [
      { query: new Float32Array([1, 0]), candidates, positiveId: 'y' },
      { query: new Float32Array([1, 0]), candidates, positiveId: 'z' }
    ];

    const result = AdapterEvaluator.evaluate(identity, examples, [1]);

    expect(result.coverage).toBeCloseTo(1 / 3, 5); // only 'x' surfaced of {x,y,z}
  });
});

describe('AdapterEvaluator.shouldPromote', () => {
  const base: EvalResult = { mrr: 0.5, recallAtK: {}, coverage: 0.9, examples: 50 };

  it('promotes a genuine relevance gain that keeps coverage', () => {
    const after: EvalResult = { mrr: 0.7, recallAtK: {}, coverage: 0.9, examples: 50 };
    expect(AdapterEvaluator.shouldPromote(base, after, { mrrMargin: 0.01, coverageFloor: 0.8 })).toBe(true);
  });

  it('rejects an MRR gain that collapses coverage', () => {
    const after: EvalResult = { mrr: 0.9, recallAtK: {}, coverage: 0.4, examples: 50 };
    expect(AdapterEvaluator.shouldPromote(base, after, { mrrMargin: 0.01, coverageFloor: 0.8 })).toBe(false);
  });

  it('rejects an improvement below the margin', () => {
    const after: EvalResult = { mrr: 0.505, recallAtK: {}, coverage: 0.9, examples: 50 };
    expect(AdapterEvaluator.shouldPromote(base, after, { mrrMargin: 0.01, coverageFloor: 0.8 })).toBe(false);
  });
});
