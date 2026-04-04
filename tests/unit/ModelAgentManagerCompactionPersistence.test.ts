import { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';
import { CompactedContext } from '../../src/services/chat/ContextCompactionService';
import type { ModelOption } from '../../src/ui/chat/types/SelectionTypes';

type ModelAgentManagerTestAccess = ModelAgentManager & {
  getAvailableModels(): Promise<ModelOption[]>;
  getAvailablePrompts(): Promise<unknown[]>;
};

type CompactionMetadata = {
  compaction: {
    frontier: unknown[];
  };
};

function withCoverage(record: CompactedContext): CompactedContext & {
  transcriptCoverage: NonNullable<CompactedContext['transcriptCoverage']>;
} {
  if (!record.transcriptCoverage) {
    throw new Error('Expected transcript coverage');
  }
  return {
    ...record,
    transcriptCoverage: record.transcriptCoverage
  };
}

function asManager(manager: ModelAgentManager): ModelAgentManagerTestAccess {
  return manager as ModelAgentManagerTestAccess;
}

describe('ModelAgentManager compaction persistence', () => {
  const initialCompactionRecord: CompactedContext = {
    summary: 'Previous work summary',
    messagesRemoved: 12,
    messagesKept: 4,
    filesReferenced: ['Note A.md'],
    topics: ['Refactor', 'Tests'],
    compactedAt: 1_742_900_000_000,
    transcriptCoverage: {
      conversationId: 'conv_1',
      startSequenceNumber: 0,
      endSequenceNumber: 11
    }
  };
  const secondContext: CompactedContext = {
    ...initialCompactionRecord,
    summary: 'Second compacted summary',
    compactedAt: 1_742_900_000_100,
    transcriptCoverage: {
      conversationId: 'conv_1',
      startSequenceNumber: 12,
      endSequenceNumber: 23
    }
  };
  const thirdContext: CompactedContext = {
    ...initialCompactionRecord,
    summary: 'Third compacted summary',
    compactedAt: 1_742_900_000_200,
    transcriptCoverage: {
      conversationId: 'conv_1',
      startSequenceNumber: 24,
      endSequenceNumber: 35
    }
  };
  const fourthContext: CompactedContext = {
    ...initialCompactionRecord,
    summary: 'Fourth compacted summary',
    compactedAt: 1_742_900_000_300,
    transcriptCoverage: {
      conversationId: 'conv_1',
      startSequenceNumber: 36,
      endSequenceNumber: 47
    }
  };

  function createManager(conversationService?: { getConversation: jest.Mock }) {
    return new ModelAgentManager(
      {},
      {
        onModelChanged: jest.fn(),
        onPromptChanged: jest.fn(),
        onSystemPromptChanged: jest.fn()
      },
      conversationService
    );
  }

  function createModel(providerId: string, contextWindow: number): ModelOption {
    return {
      providerId,
      providerName: providerId,
      modelId: `${providerId}-model`,
      modelName: `${providerId} model`,
      contextWindow
    };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores compacted records under metadata.compaction.frontier', () => {
    const manager = createManager();

    const metadata = manager.buildMetadataWithCompactionRecord(
      {
        chatSettings: {
          providerId: 'anthropic-claude-code',
          modelId: 'claude-sonnet-4-6'
        }
      },
      initialCompactionRecord
    );

    const initialRecord = withCoverage(initialCompactionRecord);

    expect(metadata).toEqual({
      chatSettings: {
        providerId: 'anthropic-claude-code',
        modelId: 'claude-sonnet-4-6'
      },
      compaction: {
        frontier: [{
          ...initialRecord,
          level: 0,
          mergedRecordCount: 1,
          transcriptCoverageAncestry: [initialRecord.transcriptCoverage]
        }]
      }
    });
  });

  it('restores frontier metadata during initializeFromConversation', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            providerId: 'anthropic-claude-code',
            modelId: 'claude-sonnet-4-6'
          },
          compaction: {
            frontier: [initialCompactionRecord, secondContext]
          }
        }
      })
    };

    const manager = createManager(conversationService);
    jest.spyOn(asManager(manager), 'getAvailableModels').mockResolvedValue([
      {
        providerId: 'anthropic-claude-code',
        modelId: 'claude-sonnet-4-6',
        providerName: 'Anthropic Claude Code',
        modelName: 'Claude Sonnet 4.6',
        contextWindow: 200_000
      }
    ]);
    jest.spyOn(asManager(manager), 'getAvailablePrompts').mockResolvedValue([]);

    await manager.initializeFromConversation('conv_1');

    expect(manager.getCompactionFrontier()).toEqual([
      {
        ...withCoverage(initialCompactionRecord),
        level: 0,
        mergedRecordCount: 1,
        transcriptCoverageAncestry: [withCoverage(initialCompactionRecord).transcriptCoverage]
      },
      {
        ...withCoverage(secondContext),
        level: 0,
        mergedRecordCount: 1,
        transcriptCoverageAncestry: [withCoverage(secondContext).transcriptCoverage]
      }
    ]);
    expect(manager.getLatestCompactionRecord()).toEqual({
      ...withCoverage(secondContext),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(secondContext).transcriptCoverage]
    });
  });

  it('restores legacy single-record metadata as a one-record frontier', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            providerId: 'anthropic-claude-code',
            modelId: 'claude-sonnet-4-6'
          },
          compaction: {
            previousContext: initialCompactionRecord
          }
        }
      })
    };

    const manager = createManager(conversationService);
    jest.spyOn(asManager(manager), 'getAvailableModels').mockResolvedValue([
      {
        providerId: 'anthropic-claude-code',
        modelId: 'claude-sonnet-4-6',
        providerName: 'Anthropic Claude Code',
        modelName: 'Claude Sonnet 4.6',
        contextWindow: 200_000
      }
    ]);
    jest.spyOn(asManager(manager), 'getAvailablePrompts').mockResolvedValue([]);

    await manager.initializeFromConversation('conv_legacy');

    expect(manager.getCompactionFrontier()).toEqual([{
      ...withCoverage(initialCompactionRecord),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(initialCompactionRecord).transcriptCoverage]
    }]);
    expect(manager.getLatestCompactionRecord()).toEqual({
      ...withCoverage(initialCompactionRecord),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(initialCompactionRecord).transcriptCoverage]
    });
  });

  it('meta-compacts the oldest frontier records when the bounded frontier would overflow', () => {
    const manager = createManager();

    manager.appendCompactionRecord(initialCompactionRecord);
    manager.appendCompactionRecord(secondContext);
    manager.appendCompactionRecord(thirdContext);
    manager.appendCompactionRecord(fourthContext);

    const frontier = manager.getCompactionFrontier();

    expect(frontier).toHaveLength(3);
    expect(frontier[0]).toMatchObject({
      level: 1,
      mergedRecordCount: 2,
      compactedAt: secondContext.compactedAt
    });
    expect(frontier[0].transcriptCoverageAncestry).toEqual([
      initialCompactionRecord.transcriptCoverage,
      secondContext.transcriptCoverage
    ]);
    expect(frontier[1]).toMatchObject({
      ...withCoverage(thirdContext),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(thirdContext).transcriptCoverage]
    });
    expect(frontier[2]).toMatchObject({
      ...withCoverage(fourthContext),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(fourthContext).transcriptCoverage]
    });
    expect(manager.getLatestCompactionRecord()).toEqual({
      ...withCoverage(fourthContext),
      level: 0,
      mergedRecordCount: 1,
      transcriptCoverageAncestry: [withCoverage(fourthContext).transcriptCoverage]
    });
  });

  it('derives a larger frontier budget for 200k soft-cap models than for webllm', () => {
    const manager = createManager();

    manager.handleModelChange(createModel('webllm', 4096));
    const webllmPolicy = manager.getCompactionFrontierBudgetPolicy();

    manager.handleModelChange(createModel('openai-codex', 200000));
    const codexPolicy = manager.getCompactionFrontierBudgetPolicy();

    expect(webllmPolicy.maxEstimatedTokens).toBe(900);
    expect(codexPolicy.maxEstimatedTokens).toBeGreaterThan(webllmPolicy.maxEstimatedTokens);
    expect(codexPolicy.maxEstimatedTokens).toBe(12000);
  });

  it('clears stale frontier when reloading a conversation without persisted compaction metadata', async () => {
    const conversationService = {
      getConversation: jest.fn().mockResolvedValue({
        metadata: {
          chatSettings: {
            providerId: 'anthropic-claude-code',
            modelId: 'claude-sonnet-4-6'
          }
        }
      })
    };

    const manager = createManager(conversationService);
    manager.appendCompactionRecord(initialCompactionRecord);
    jest.spyOn(asManager(manager), 'getAvailableModels').mockResolvedValue([
      {
        providerId: 'anthropic-claude-code',
        modelId: 'claude-sonnet-4-6',
        providerName: 'Anthropic Claude Code',
        modelName: 'Claude Sonnet 4.6',
        contextWindow: 200_000
      }
    ]);
    jest.spyOn(asManager(manager), 'getAvailablePrompts').mockResolvedValue([]);

    await manager.initializeFromConversation('conv_2');

    expect(manager.getLatestCompactionRecord()).toBeNull();
    expect(manager.getCompactionFrontier()).toEqual([]);
  });

  it('keeps deprecated previousContext-named shims working during the rename transition', () => {
    const manager = createManager();

    manager.setPreviousContext(initialCompactionRecord);

    expect(manager.getPreviousContext()).toEqual(manager.getLatestCompactionRecord());
    expect(manager.hasPreviousContext()).toBe(manager.hasCompactionFrontier());

    const metadata = manager.buildMetadataWithPreviousContext(
      manager.buildMetadataWithCompactionRecord(undefined, initialCompactionRecord),
      secondContext
    );
    expect((metadata as CompactionMetadata).compaction.frontier).toHaveLength(2);

    manager.clearPreviousContext();
    expect(manager.getCompactionFrontier()).toEqual([]);
  });
});
