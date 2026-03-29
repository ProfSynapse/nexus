import {
  CompactionFrontierRecord,
  CompactionFrontierService
} from '../../src/services/chat/CompactionFrontierService';

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
