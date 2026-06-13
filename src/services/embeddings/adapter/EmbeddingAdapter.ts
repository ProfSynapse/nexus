/**
 * Location: src/services/embeddings/adapter/EmbeddingAdapter.ts
 * Purpose: Query-side embedding adapter for the self-improving retrieval system.
 *
 * A frozen MiniLM encoder produces an L2-normalized query vector `q`. This
 * adapter applies a learned low-rank residual transform and re-normalizes,
 * so ranking by `vec_distance_l2(W·q, d)` stays a monotone proxy for
 * `cosine(W·q, d)` over the (already-normalized) stored note vectors `d`.
 *
 *   W = I + U·Vᵀ          (low-rank residual; rank 0 ⇒ identity)
 *   q' = normalize(q + α·U·(Vᵀ·q))
 *
 * The transform is applied to the QUERY only — stored document vectors are
 * never touched, so a new adapter never forces a re-embed of the vault.
 *
 * IDENTITY GUARANTEE: an identity adapter (rank 0 / α 0 / no factors) returns
 * the input array unchanged (same reference, no recompute), so shipping it is
 * byte-for-byte equivalent to having no adapter at all.
 *
 * Mobile-safe: pure arithmetic, no Node or Obsidian imports.
 */

export const DEFAULT_EMBEDDING_DIM = 384;

/** Minimal contract consumed by the embedding services. */
export interface QueryAdapter {
  readonly isIdentity: boolean;
  readonly version: number;
  transform(query: Float32Array): Float32Array;
}

/** Serialized adapter — small (a few hundred KB), synced through the event store. */
export interface AdapterSnapshot {
  /** Monotonic adapter version (last-writer-wins across devices). */
  version: number;
  /** Embedding dimension the factors are sized for. */
  dim: number;
  /** Low-rank size; 0 means identity. */
  rank: number;
  /** Blend factor in [0,1]; how hard the learned bias tilts the base space. */
  alpha: number;
  /** dim × rank left factor. */
  U?: number[][];
  /** dim × rank right factor. */
  V?: number[][];
  /** When the factors were last trained (ms epoch). */
  trainedAt?: number;
}

function isFiniteMatrix(m: unknown, rows: number, cols: number): m is number[][] {
  if (!Array.isArray(m) || m.length !== rows) {
    return false;
  }
  for (const row of m) {
    if (!Array.isArray(row) || row.length !== cols) {
      return false;
    }
    for (const value of row) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
      }
    }
  }
  return true;
}

export class EmbeddingAdapter implements QueryAdapter {
  readonly version: number;
  readonly dim: number;
  readonly rank: number;
  readonly alpha: number;
  private readonly U: number[][] | null;
  private readonly V: number[][] | null;

  private constructor(params: {
    version: number;
    dim: number;
    rank: number;
    alpha: number;
    U: number[][] | null;
    V: number[][] | null;
  }) {
    this.version = params.version;
    this.dim = params.dim;
    this.rank = params.rank;
    this.alpha = params.alpha;
    this.U = params.U;
    this.V = params.V;
  }

  /** The no-op adapter — identical behavior to having no adapter. */
  static identity(dim: number = DEFAULT_EMBEDDING_DIM): EmbeddingAdapter {
    return new EmbeddingAdapter({ version: 0, dim, rank: 0, alpha: 0, U: null, V: null });
  }

  /**
   * Build from a (possibly untrusted / synced) snapshot. Any structural
   * problem — wrong dimensions, non-finite weights — degrades to identity
   * rather than corrupting search.
   */
  static fromSnapshot(snapshot: AdapterSnapshot | null | undefined): EmbeddingAdapter {
    if (!snapshot || typeof snapshot.dim !== 'number' || snapshot.dim <= 0) {
      return EmbeddingAdapter.identity();
    }

    const dim = Math.floor(snapshot.dim);
    const rank = Number.isInteger(snapshot.rank) && snapshot.rank > 0 ? snapshot.rank : 0;
    const alpha = typeof snapshot.alpha === 'number' && Number.isFinite(snapshot.alpha)
      ? Math.min(1, Math.max(0, snapshot.alpha))
      : 0;
    const version = Number.isFinite(snapshot.version) ? snapshot.version : 0;

    if (rank === 0 || alpha === 0) {
      return new EmbeddingAdapter({ version, dim, rank: 0, alpha: 0, U: null, V: null });
    }

    if (!isFiniteMatrix(snapshot.U, dim, rank) || !isFiniteMatrix(snapshot.V, dim, rank)) {
      console.warn('[EmbeddingAdapter] Invalid factor shape in snapshot; falling back to identity.');
      return EmbeddingAdapter.identity(dim);
    }

    return new EmbeddingAdapter({ version, dim, rank, alpha, U: snapshot.U, V: snapshot.V });
  }

  get isIdentity(): boolean {
    return this.rank === 0 || this.alpha === 0 || !this.U || !this.V;
  }

  /**
   * Apply the query-side transform. Identity adapters (and dimension
   * mismatches) return the input untouched.
   */
  transform(query: Float32Array): Float32Array {
    if (this.isIdentity || query.length !== this.dim || !this.U || !this.V) {
      return query;
    }

    const { dim, rank, alpha, U, V } = this;

    // t = Vᵀ · q  (rank-dim)
    const t = new Float64Array(rank);
    for (let k = 0; k < rank; k++) {
      let acc = 0;
      for (let i = 0; i < dim; i++) {
        acc += V[i][k] * query[i];
      }
      t[k] = acc;
    }

    // out = q + α·(U · t), then L2-normalize
    const out = new Float32Array(dim);
    let normSq = 0;
    for (let i = 0; i < dim; i++) {
      let delta = 0;
      const row = U[i];
      for (let k = 0; k < rank; k++) {
        delta += row[k] * t[k];
      }
      const value = query[i] + alpha * delta;
      out[i] = value;
      normSq += value * value;
    }

    const norm = Math.sqrt(normSq);
    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        out[i] = out[i] / norm;
      }
    }
    return out;
  }

  toSnapshot(): AdapterSnapshot {
    const snapshot: AdapterSnapshot = {
      version: this.version,
      dim: this.dim,
      rank: this.rank,
      alpha: this.alpha
    };
    if (!this.isIdentity && this.U && this.V) {
      snapshot.U = this.U;
      snapshot.V = this.V;
    }
    return snapshot;
  }
}
