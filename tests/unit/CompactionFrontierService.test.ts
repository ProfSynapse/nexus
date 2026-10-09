import {
  CompactionFrontierRecord,
  CompactionFrontierService
} from '../../src/services/chat/CompactionFrontierService';
import { ContextCompactionService } from '../../src/services/chat/ContextCompactionService';
import { ModelAgentCompactionState } from '../../src/ui/chat/services/ModelAgentCompactionState';
import type { ConversationData } from '../../src/types/chat/ChatTypes';

function createRecord(
  summary: string,
  compactedAt: number,
  rangeStart: number
): CompactionFrontierRecord {
  return {
    summary,
    messagesRemoved: 4,
    messagesKept: 2,
    filesReferenced: [`${summary}.md`],
    topics: [summary],
    compactedAt,
    transcriptCoverage: {
      conversationId: 'conv_1',
      startSequenceNumber: rangeStart,
      endSequenceNumber: rangeStart + 3
    }
  };
}

describe('CompactionFrontierService', () => {
  it.each(['at', 'after'] as const)('keeps the newest %s boundary through budget merging and metadata reload', mode => {
    const state = new ModelAgentCompactionState();
    state.updatePolicy(128_000);
    const messages: ConversationData['messages'] = Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `Message ${index}`, timestamp: index, conversationId: 'conv_1'
    }));
    const old = { ...createRecord('old', 1000, 0), summary: 'x'.repeat(40_000), boundaryMessageId: 'm8', boundaryMode: 'at' as const };
    const newest = { ...createRecord('new', 1001, 10), boundaryMessageId: 'm9', boundaryMode: mode };
    const metadata = state.buildMetadataWithCompactionRecord({ compaction: { frontier: [old] } }, newest);
    // Exercise the persisted shape, not just the private merging implementation.
    const reloaded = JSON.parse(JSON.stringify(metadata)) as ConversationData['metadata'];
    expect(ContextCompactionService.getMessagesAfterBoundary(messages, reloaded)).toEqual(mode === 'at' ? [messages[9]] : []);
    const future = { ...messages[0], id: 'future', content: 'Next request' };
    expect(ContextCompactionService.getMessagesAfterBoundary([...messages, future], reloaded)).toEqual(mode === 'at' ? [messages[9], future] : [future]);
  });

  it('preserves a known boundary when merging an older legacy record without one', () => {
    const service = new CompactionFrontierService({ maxRecords: 1, maxEstimatedTokens: 100, metaCompactOldestCount: 2 });
    const first = { ...createRecord('first', 1000, 0), boundaryMessageId: 'm3', boundaryMode: 'after' as const };
    const merged = service.appendRecord([first], createRecord('legacy', 1001, 4));
    expect(merged[0]).toMatchObject({ boundaryMessageId: 'm3', boundaryMode: 'after' });
  });

  it('derives a tight frontier budget for small-context models and a much larger one for 200k caps', () => {
    const webllmPolicy = CompactionFrontierService.createPolicyForContextWindow(4096);
    const softCapPolicy = CompactionFrontierService.createPolicyForContextWindow(200000);

    expect(webllmPolicy.maxEstimatedTokens).toBe(900);
    expect(softCapPolicy.maxEstimatedTokens).toBeGreaterThan(webllmPolicy.maxEstimatedTokens);
    expect(softCapPolicy.maxEstimatedTokens).toBe(12000);
  });

  it('meta-compacts the oldest frontier records when record-count budget is exceeded', () => {
    const service = new CompactionFrontierService({
      maxRecords: 3,
      maxEstimatedTokens: 10_000,
      metaCompactOldestCount: 2
    });

    const frontier = service.appendRecord(
      [
        createRecord('first', 1000, 0),
        createRecord('second', 1001, 10),
        createRecord('third', 1002, 20)
      ],
      createRecord('fourth', 1003, 30)
    );

    expect(frontier).toHaveLength(3);
    expect(frontier[0]).toMatchObject({
      level: 1,
      mergedRecordCount: 2,
      compactedAt: 1001
    });
    expect(frontier[0].summary).toContain('Merged 2 earlier compaction records:');
    expect(frontier[0].transcriptCoverageAncestry).toEqual([
      {
        conversationId: 'conv_1',
        startSequenceNumber: 0,
        endSequenceNumber: 3
      },
      {
        conversationId: 'conv_1',
        startSequenceNumber: 10,
        endSequenceNumber: 13
      }
    ]);
    expect(frontier[1].summary).toBe('third');
    expect(frontier[2].summary).toBe('fourth');
  });

  it('meta-compacts on estimated frontier-token budget even before record count is exceeded', () => {
    const service = new CompactionFrontierService({
      maxRecords: 4,
      maxEstimatedTokens: 120,
      metaCompactOldestCount: 2
    });

    const longSummary = 'x'.repeat(500);
    const frontier = service.appendRecord(
      [
        createRecord(longSummary, 1000, 0),
        createRecord(longSummary, 1001, 10)
      ],
      createRecord(longSummary, 1002, 20)
    );

    expect(frontier[0].level).toBeGreaterThan(0);
    expect(frontier[0].mergedRecordCount).toBeGreaterThan(1);
    expect(frontier[0].transcriptCoverageAncestry).toHaveLength(3);
    expect(frontier.length).toBeLessThanOrEqual(2);
  });

  it('keeps a larger active frontier under the same inputs when using a 200k-derived policy', () => {
    const smallContextService = new CompactionFrontierService(
      CompactionFrontierService.createPolicyForContextWindow(4096)
    );
    const softCapService = new CompactionFrontierService(
      CompactionFrontierService.createPolicyForContextWindow(200000)
    );

    const longSummary = 'x'.repeat(500);
    const sameFrontierInput = [
      createRecord(longSummary, 1000, 0),
      createRecord(longSummary, 1001, 10),
      createRecord(longSummary, 1002, 20)
    ];

    const smallContextFrontier = smallContextService.normalizeFrontier(sameFrontierInput);
    const softCapFrontier = softCapService.normalizeFrontier(sameFrontierInput);

    expect(smallContextFrontier[0].level).toBeGreaterThan(0);
    expect(softCapFrontier.every(record => (record.level ?? 0) === 0)).toBe(true);
    expect(softCapFrontier).toHaveLength(3);
  });
});
