import { EmbeddingAdapter, AdapterSnapshot } from '../../src/services/embeddings/adapter/EmbeddingAdapter';

const l2 = (v: Float32Array): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

describe('EmbeddingAdapter', () => {
  describe('identity', () => {
    it('reports identity and version 0', () => {
      const adapter = EmbeddingAdapter.identity();
      expect(adapter.isIdentity).toBe(true);
      expect(adapter.version).toBe(0);
    });

    it('returns the exact same array reference (byte-identical, no recompute)', () => {
      const adapter = EmbeddingAdapter.identity();
      const q = new Float32Array([0.1, 0.2, 0.3]);
      const out = adapter.transform(q);
      expect(out).toBe(q); // same reference — guarantees zero behavior change
    });
  });

  describe('fromSnapshot', () => {
    it('degrades to identity for rank 0', () => {
      const adapter = EmbeddingAdapter.fromSnapshot({ version: 5, dim: 384, rank: 0, alpha: 0.5 });
      expect(adapter.isIdentity).toBe(true);
    });

    it('degrades to identity for alpha 0', () => {
      const snap: AdapterSnapshot = {
        version: 5, dim: 2, rank: 1, alpha: 0, U: [[1], [1]], V: [[1], [1]]
      };
      expect(EmbeddingAdapter.fromSnapshot(snap).isIdentity).toBe(true);
    });

    it('degrades to identity when factor shapes are invalid', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const snap = { version: 5, dim: 2, rank: 1, alpha: 1, U: [[1]], V: [[1], [1]] } as AdapterSnapshot;
      const adapter = EmbeddingAdapter.fromSnapshot(snap);
      expect(adapter.isIdentity).toBe(true);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('degrades to identity for null / malformed snapshots', () => {
      expect(EmbeddingAdapter.fromSnapshot(null).isIdentity).toBe(true);
      expect(EmbeddingAdapter.fromSnapshot({ dim: 0 } as AdapterSnapshot).isIdentity).toBe(true);
    });

    it('clamps alpha into [0,1]', () => {
      const snap: AdapterSnapshot = {
        version: 1, dim: 2, rank: 1, alpha: 5, U: [[0], [1]], V: [[1], [0]]
      };
      expect(EmbeddingAdapter.fromSnapshot(snap).alpha).toBe(1);
    });
  });

  describe('transform', () => {
    it('applies the residual blend and re-normalizes to unit length', () => {
      // q = [1,0]; V = [[1],[0]] ⇒ Vᵀq = 1; U = [[0],[1]] ⇒ delta = [0,1]
      // out = normalize([1,0] + 1·[0,1]) = normalize([1,1]) = [1/√2, 1/√2]
      const adapter = EmbeddingAdapter.fromSnapshot({
        version: 1, dim: 2, rank: 1, alpha: 1, U: [[0], [1]], V: [[1], [0]]
      });
      const out = adapter.transform(new Float32Array([1, 0]));
      expect(out[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(out[1]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(l2(out)).toBeCloseTo(1, 5);
    });

    it('returns the input untouched on dimension mismatch', () => {
      const adapter = EmbeddingAdapter.fromSnapshot({
        version: 1, dim: 2, rank: 1, alpha: 1, U: [[0], [1]], V: [[1], [0]]
      });
      const q = new Float32Array([1, 2, 3]); // dim 3 ≠ adapter dim 2
      expect(adapter.transform(q)).toBe(q);
    });
  });

  describe('toSnapshot', () => {
    it('round-trips a trained adapter', () => {
      const snap: AdapterSnapshot = {
        version: 7, dim: 2, rank: 1, alpha: 0.5, U: [[0.1], [0.2]], V: [[0.3], [0.4]]
      };
      const restored = EmbeddingAdapter.fromSnapshot(EmbeddingAdapter.fromSnapshot(snap).toSnapshot());
      expect(restored.isIdentity).toBe(false);
      expect(restored.version).toBe(7);
      expect(restored.alpha).toBe(0.5);
    });

    it('omits factors for an identity adapter', () => {
      const snap = EmbeddingAdapter.identity().toSnapshot();
      expect(snap.rank).toBe(0);
      expect(snap.U).toBeUndefined();
      expect(snap.V).toBeUndefined();
    });
  });
});
