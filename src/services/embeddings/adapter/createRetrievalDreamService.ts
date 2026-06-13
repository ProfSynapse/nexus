/**
 * Location: src/services/embeddings/adapter/createRetrievalDreamService.ts
 * Purpose: Assemble the production dream-consolidation loop from live pieces.
 *
 * Keeps EmbeddingManager's wiring to a single call and stays unit-testable
 * (each collaborator is constructed from injected primitives).
 */

import type { EmbeddingService } from '../EmbeddingService';
import { AdapterStore } from './AdapterStore';
import { EmbeddingAdapter } from './EmbeddingAdapter';
import { DreamConsolidationService, DreamConfig } from './DreamConsolidationService';
import {
  EmbeddingFeedbackProvider,
  TraceFeedbackSource,
  MemoryTraceQuery
} from './RetrievalFeedbackSources';

type VaultSettings = ConstructorParameters<typeof AdapterStore>[1];

export interface RetrievalDreamWiring {
  service: EmbeddingService;
  db: MemoryTraceQuery;
  /** Obsidian DataAdapter for the synced adapter file. */
  fs: ConstructorParameters<typeof AdapterStore>[0];
  getSettings: VaultSettings;
  configDir?: string;
  /** Max recent traces to mine per cycle. */
  traceLimit?: number;
  dreamConfig?: DreamConfig;
}

export interface RetrievalDream {
  store: AdapterStore;
  dream: DreamConsolidationService;
  /** Load the persisted adapter and apply it to the live search path. */
  loadAndApply: () => Promise<EmbeddingAdapter>;
}

export function createRetrievalDreamService(w: RetrievalDreamWiring): RetrievalDream {
  const store = new AdapterStore(w.fs, w.getSettings, w.configDir);
  const traceSource = new TraceFeedbackSource(w.db);
  const embeddings = new EmbeddingFeedbackProvider(w.service);

  const dream = new DreamConsolidationService({
    getTraceRecords: () => traceSource.getRecords(w.traceLimit),
    embeddings,
    store,
    applyAdapter: (adapter) => w.service.setAdapter(adapter),
    config: w.dreamConfig
  });

  return {
    store,
    dream,
    loadAndApply: async () => {
      const adapter = await store.load();
      if (!adapter.isIdentity) {
        w.service.setAdapter(adapter);
      }
      return adapter;
    }
  };
}
