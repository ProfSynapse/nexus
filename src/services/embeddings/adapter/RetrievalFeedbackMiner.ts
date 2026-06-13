/**
 * Location: src/services/embeddings/adapter/RetrievalFeedbackMiner.ts
 * Purpose: Turn captured retrieval traces into labeled training examples.
 *
 * Phase 0 persisted, per successful search, the candidate set it returned
 * (`outcome.retrieval = { groupId, candidates }`). This miner reconstructs the
 * relevance LABEL by joining each search to a later "use" of one of its
 * candidates within the same session:
 *
 *   search(query → candidates) … then read/loadState/cite(candidate p)
 *      ⇒ positive = p,  negatives = the other returned candidates
 *
 * Task completion is the strongest reward: a search whose used candidate is
 * followed by a task finishing in the session is up-weighted (not the weak
 * "did they click it" signal). The join is the offline ("dreaming") work; the
 * trace capture stayed minimal on purpose.
 *
 * Decoupled from storage and the encoder via two injected ports, so the join
 * logic is pure and testable with fake embeddings:
 *  - trace records are mapped in by the caller (from memory_traces),
 *  - vectors come from a FeedbackEmbeddingProvider (real engine / note table,
 *    or a fake in tests).
 */

export interface RetrievalCandidateRef {
  path: string;
  score?: number;
}

/**
 * A flattened view of one tool-call trace, sufficient for mining. The
 * production source maps `memory_traces` rows into these.
 */
export interface RetrievalTraceRecord {
  sessionId: string;
  workspaceId: string;
  timestamp: number;
  /** Tool agent (e.g. "searchManager", "contentManager", "taskManager"). */
  agent: string;
  /** Tool mode (e.g. "content", "memory", "read", "loadState", "updateTask"). */
  mode: string;
  /** The query text, for search records. */
  query?: string;
  /** Present on a successful search: what it returned. */
  retrieval?: { groupId: string; candidates: RetrievalCandidateRef[] };
  /** Identifiers this call "used" (read path, loaded state id, …). */
  usedPaths?: string[];
  /** True when this record represents a task transitioning to done. */
  taskCompleted?: boolean;
}

export interface FeedbackEmbeddingProvider {
  /** Embed query text (unit-norm). null when unavailable. */
  embedQuery(query: string): Promise<Float32Array | null>;
  /** Fetch a stored document vector by identifier (unit-norm). null if absent. */
  getDocVector(path: string): Promise<Float32Array | null>;
}

/** Unified mined example — both training and eval views derive from it. */
export interface MinedExample {
  query: Float32Array;
  candidates: Array<{ id: string; vec: Float32Array }>;
  positiveId: string;
  weight: number;
  timestamp: number;
}

export interface MineConfig {
  /** Extra weight for examples whose positive precedes a task completion. */
  taskRewardWeight?: number;
  /** Cap negatives kept per example (hard negatives are the returned ones). */
  maxNegatives?: number;
  /** Per-rank exposure-debias slope: how much more a deeper-buried hit counts. */
  exposureStep?: number;
  /** Hard cap on any single example's weight. */
  maxWeight?: number;
}

const DEFAULTS = { taskRewardWeight: 3, maxNegatives: 12, exposureStep: 0.5, maxWeight: 8 };

/** A "use" of one of a search's candidates (or a task completion) in-session. */
function isUseRecord(r: RetrievalTraceRecord): boolean {
  return (r.usedPaths?.length ?? 0) > 0 || r.taskCompleted === true;
}

export class RetrievalFeedbackMiner {
  constructor(
    private readonly embeddings: FeedbackEmbeddingProvider,
    private readonly config: MineConfig = {}
  ) {}

  async mine(records: RetrievalTraceRecord[]): Promise<MinedExample[]> {
    const cfg = { ...DEFAULTS, ...this.config };

    // Group by session, ascending time.
    const bySession = new Map<string, RetrievalTraceRecord[]>();
    for (const r of records) {
      const list = bySession.get(r.sessionId) ?? [];
      list.push(r);
      bySession.set(r.sessionId, list);
    }

    const out: MinedExample[] = [];
    for (const list of bySession.values()) {
      list.sort((a, b) => a.timestamp - b.timestamp);

      for (let i = 0; i < list.length; i++) {
        const search = list[i];
        if (!search.retrieval || !search.query || search.retrieval.candidates.length < 2) {
          continue;
        }
        const candidatePaths = search.retrieval.candidates.map(c => c.path);
        const candidateSet = new Set(candidatePaths);

        // Find the first later use of a candidate in this session.
        let usedPath: string | undefined;
        let taskRewarded = false;
        for (let j = i + 1; j < list.length; j++) {
          const later = list[j];
          if (!isUseRecord(later)) continue;
          const hit = (later.usedPaths ?? []).find(p => candidateSet.has(p));
          if (hit) {
            usedPath = hit;
            // Was a task completed at/after this use, still in-session?
            taskRewarded = later.taskCompleted === true ||
              list.slice(j).some(r => r.taskCompleted === true);
            break;
          }
        }
        if (!usedPath) continue;

        // Skip-above (Joachims): negatives are ONLY the candidates the retriever
        // ranked above the used one — the ones it confidently put too high.
        // Candidates ranked BELOW the used one are not evidence of irrelevance
        // (often relevant-but-redundant), so excluding them avoids training the
        // model to suppress good results (the false-negative cheat).
        const usedRank = candidatePaths.indexOf(usedPath);
        const negativePaths = candidatePaths.slice(0, usedRank);

        // A rank-0 use confirms the retriever and carries NO contrastive signal —
        // training on it only reinforces the status quo (the self-confirmation
        // cheat). Drop it; we learn from the retriever's mistakes.
        if (negativePaths.length === 0) continue;

        // Exposure-debias: the deeper the used item was buried, the more wrong
        // the retriever was, so the more this example should count.
        const exposureWeight = 1 + (usedRank - 1) * cfg.exposureStep;
        const weight = Math.min(cfg.maxWeight, exposureWeight * (taskRewarded ? cfg.taskRewardWeight : 1));

        const example = await this.buildExample(
          search.query,
          usedPath,
          negativePaths,
          search.timestamp,
          weight,
          cfg.maxNegatives
        );
        if (example) out.push(example);
      }
    }

    return out;
  }

  private async buildExample(
    query: string,
    positivePath: string,
    negativePaths: string[],
    timestamp: number,
    weight: number,
    maxNegatives: number
  ): Promise<MinedExample | null> {
    const queryVec = await this.embeddings.embedQuery(query);
    const positiveVec = await this.embeddings.getDocVector(positivePath);
    if (!queryVec || !positiveVec) {
      return null;
    }

    const candidates: MinedExample['candidates'] = [{ id: positivePath, vec: positiveVec }];
    for (const path of negativePaths.slice(0, maxNegatives)) {
      const vec = await this.embeddings.getDocVector(path);
      if (vec && vec.length === positiveVec.length) {
        candidates.push({ id: path, vec });
      }
    }

    if (candidates.length < 2) {
      return null; // need at least one negative to contrast
    }

    return { query: queryVec, candidates, positiveId: positivePath, weight, timestamp };
  }
}

/** Derive a trainer example from a mined one. */
export function toTrainingExample(m: MinedExample): {
  query: Float32Array; positive: Float32Array; negatives: Float32Array[]; weight: number;
} {
  const positive = m.candidates.find(c => c.id === m.positiveId)!.vec;
  const negatives = m.candidates.filter(c => c.id !== m.positiveId).map(c => c.vec);
  return { query: m.query, positive, negatives, weight: m.weight };
}

/** Derive an evaluator example from a mined one. */
export function toEvalExample(m: MinedExample): {
  query: Float32Array; candidates: Array<{ id: string; vec: Float32Array }>; positiveId: string;
} {
  return { query: m.query, candidates: m.candidates, positiveId: m.positiveId };
}
