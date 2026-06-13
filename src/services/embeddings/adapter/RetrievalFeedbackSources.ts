/**
 * Location: src/services/embeddings/adapter/RetrievalFeedbackSources.ts
 * Purpose: Production wiring for the retrieval-feedback pipeline.
 *
 *  - EmbeddingFeedbackProvider: query/doc vectors from the live embedding system.
 *  - TraceFeedbackSource: reads memory_traces (populated by Phase 0) and maps
 *    them into the RetrievalTraceRecord shape the miner consumes, expanding
 *    useTools batch traces into one record per sub-call.
 *
 * Both are thin and defensive; the join/learning logic lives in the (tested)
 * miner and dream service.
 */

import type { EmbeddingService } from '../EmbeddingService';
import type {
  FeedbackEmbeddingProvider,
  RetrievalTraceRecord,
  RetrievalCandidateRef
} from './RetrievalFeedbackMiner';

/** Query/doc vectors backed by the live embedding system. */
export class EmbeddingFeedbackProvider implements FeedbackEmbeddingProvider {
  constructor(private readonly service: EmbeddingService) {}

  embedQuery(query: string): Promise<Float32Array | null> {
    return this.service.embedQueryText(query);
  }

  getDocVector(path: string): Promise<Float32Array | null> {
    return this.service.getNoteVector(path);
  }
}

/** Minimal read port over the SQLite cache (structural for testability). */
export interface MemoryTraceQuery {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface TraceRow {
  sessionId: string | null;
  workspaceId: string | null;
  timestamp: number | null;
  metadataJson: string | null;
}

/** Tool modes (normalized) that represent a "use" of a retrieved item. */
const USE_MODES = new Set(['read', 'open', 'loadstate', 'loadworkspace']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function normalize(value: string): string {
  return value.replace(/[-_\s]/g, '').toLowerCase();
}

function asCandidates(value: unknown): RetrievalCandidateRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RetrievalCandidateRef[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.path === 'string') {
      out.push(typeof item.score === 'number' ? { path: item.path, score: item.score } : { path: item.path });
    }
  }
  return out.length > 0 ? out : undefined;
}

function usedPathsFor(mode: string, args: Record<string, unknown>): string[] | undefined {
  if (!USE_MODES.has(normalize(mode))) return undefined;
  const p = getString(args.path) || getString(args.filePath) || getString(args.id);
  return p ? [p] : undefined;
}

function isTaskDone(agent: string, args: Record<string, unknown>): boolean {
  if (normalize(agent) !== 'taskmanager') return false;
  return getString(args.status) === 'done' || args.completed === true;
}

export class TraceFeedbackSource {
  constructor(private readonly db: MemoryTraceQuery) {}

  /** Read recent traces and flatten them into miner records. */
  async getRecords(limit = 4000): Promise<RetrievalTraceRecord[]> {
    let rows: TraceRow[];
    try {
      rows = await this.db.query<TraceRow>(
        `SELECT sessionId, workspaceId, timestamp, metadataJson
         FROM memory_traces
         ORDER BY timestamp DESC
         LIMIT ?`,
        [limit]
      );
    } catch (error) {
      console.error('[TraceFeedbackSource] Failed to read memory_traces:', error);
      return [];
    }

    const records: RetrievalTraceRecord[] = [];
    for (const row of rows) {
      if (!row.sessionId || !row.workspaceId || row.metadataJson == null) continue;
      let metadata: Record<string, unknown>;
      try {
        metadata = JSON.parse(row.metadataJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      records.push(
        ...this.mapTrace(row.sessionId, row.workspaceId, row.timestamp ?? 0, metadata)
      );
    }
    return records;
  }

  private mapTrace(
    sessionId: string,
    workspaceId: string,
    timestamp: number,
    metadata: Record<string, unknown>
  ): RetrievalTraceRecord[] {
    const base = { sessionId, workspaceId, timestamp };

    // Batched useTools trace → one record per sub-result.
    const batch = isRecord(metadata.batch) ? metadata.batch : undefined;
    if (batch && Array.isArray(batch.results)) {
      const out: RetrievalTraceRecord[] = [];
      for (const result of batch.results) {
        if (!isRecord(result)) continue;
        const agent = getString(result.agent) ?? '';
        const mode = getString(result.tool) ?? '';
        const params = isRecord(result.params) ? result.params : {};
        const candidates = asCandidates(result.candidates);
        const groupId = getString(result.groupId);

        out.push({
          ...base,
          agent,
          mode,
          query: getString(params.query),
          retrieval: candidates && groupId ? { groupId, candidates } : undefined,
          usedPaths: usedPathsFor(mode, params),
          taskCompleted: isTaskDone(agent, params)
        });
      }
      return out;
    }

    // Direct (non-batch) trace.
    const tool = isRecord(metadata.tool) ? metadata.tool : {};
    const agent = getString(tool.agent) ?? '';
    const mode = getString(tool.mode) ?? '';
    const input = isRecord(metadata.input) ? metadata.input : {};
    const args = isRecord(input.arguments) ? input.arguments : {};
    const outcome = isRecord(metadata.outcome) ? metadata.outcome : {};
    const retrievalRaw = isRecord(outcome.retrieval) ? outcome.retrieval : undefined;
    const candidates = retrievalRaw ? asCandidates(retrievalRaw.candidates) : undefined;
    const groupId = retrievalRaw ? getString(retrievalRaw.groupId) : undefined;

    const files = Array.isArray(input.files)
      ? input.files.filter((f): f is string => typeof f === 'string')
      : undefined;

    return [{
      ...base,
      agent,
      mode,
      query: getString(args.query),
      retrieval: candidates && groupId ? { groupId, candidates } : undefined,
      usedPaths: usedPathsFor(mode, args) ?? (files && files.length > 0 ? files : undefined),
      taskCompleted: isTaskDone(agent, args)
    }];
  }
}
