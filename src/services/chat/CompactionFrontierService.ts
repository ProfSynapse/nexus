import {
  CompactedContext,
  CompactedTranscriptCoverageRef
} from './ContextCompactionService';

export interface CompactionFrontierRecord extends CompactedContext {
  level?: number;
  mergedRecordCount?: number;
  transcriptCoverageAncestry?: CompactedTranscriptCoverageRef[];
}

export interface CompactionFrontierBudgetPolicy {
  maxRecords: number;
  maxEstimatedTokens: number;
  metaCompactOldestCount: number;
}

export class CompactionFrontierService {
  static readonly DEFAULT_POLICY: CompactionFrontierBudgetPolicy = {
    maxRecords: 3,
    maxEstimatedTokens: 900,
    metaCompactOldestCount: 2
  };

  static createPolicyForContextWindow(contextWindow?: number | null): CompactionFrontierBudgetPolicy {
    if (!contextWindow || contextWindow <= 0) {
      return CompactionFrontierService.DEFAULT_POLICY;
    }

    return {
      maxRecords: CompactionFrontierService.DEFAULT_POLICY.maxRecords,
      metaCompactOldestCount: CompactionFrontierService.DEFAULT_POLICY.metaCompactOldestCount,
      maxEstimatedTokens: Math.max(
        CompactionFrontierService.DEFAULT_POLICY.maxEstimatedTokens,
        Math.min(12000, Math.round(contextWindow * 0.06))
      )
    };
  }

  constructor(
    private readonly policy: CompactionFrontierBudgetPolicy = CompactionFrontierService.DEFAULT_POLICY
  ) {}

  normalizeFrontier(frontier: CompactedContext[]): CompactionFrontierRecord[] {
    return this.enforceBudget(frontier.map(record => this.normalizeRecord(record)));
  }

  appendRecord(
    frontier: CompactedContext[],
    record: CompactedContext
  ): CompactionFrontierRecord[] {
    return this.enforceBudget([
      ...frontier.map(existing => this.normalizeRecord(existing)),
      this.normalizeRecord(record)
    ]);
  }

  estimateFrontierTokens(frontier: CompactedContext[]): number {
    return frontier
      .map(record => this.estimateRecordTokens(this.normalizeRecord(record)))
      .reduce((total, tokens) => total + tokens, 0);
  }

  private enforceBudget(frontier: CompactionFrontierRecord[]): CompactionFrontierRecord[] {
    let nextFrontier = [...frontier];

    while (
      nextFrontier.length > 1 &&
      (
        nextFrontier.length > this.policy.maxRecords ||
        this.estimateFrontierTokens(nextFrontier) > this.policy.maxEstimatedTokens
      )
    ) {
      const mergeCount = Math.min(this.policy.metaCompactOldestCount, nextFrontier.length);
      const mergedRecord = this.buildMetaRecord(nextFrontier.slice(0, mergeCount));
      nextFrontier = [mergedRecord, ...nextFrontier.slice(mergeCount)];
    }

    return nextFrontier.slice(-this.policy.maxRecords);
  }

  private buildMetaRecord(records: CompactionFrontierRecord[]): CompactionFrontierRecord {
    const normalizedRecords = records.map(record => this.normalizeRecord(record));
    const uniqueFiles = this.uniquePreservingOrder(
      normalizedRecords.flatMap(record => record.filesReferenced)
    );
    const uniqueTopics = this.uniquePreservingOrder(
      normalizedRecords.flatMap(record => record.topics)
    );
    const transcriptCoverageAncestry = this.uniqueCoverageRefs(
      normalizedRecords.flatMap(record => this.getCoverageAncestry(record))
    );
    const mergedRecordCount = normalizedRecords
      .map(record => record.mergedRecordCount ?? 1)
      .reduce((total, count) => total + count, 0);
    const nextLevel = Math.max(...normalizedRecords.map(record => record.level ?? 0)) + 1;

    return {
      summary: this.buildMetaSummary(normalizedRecords),
      messagesRemoved: normalizedRecords.reduce((total, record) => total + record.messagesRemoved, 0),
      messagesKept: normalizedRecords.reduce((total, record) => total + record.messagesKept, 0),
      filesReferenced: uniqueFiles,
      topics: uniqueTopics,
      compactedAt: normalizedRecords[normalizedRecords.length - 1].compactedAt,
      level: nextLevel,
      mergedRecordCount,
      transcriptCoverageAncestry,
    };
  }

  private buildMetaSummary(records: CompactionFrontierRecord[]): string {
    const bulletSummaries = records
      .map(record => this.truncate(record.summary, 220))
      .map(summary => `- ${summary}`);

    return [
      `Merged ${records.length} earlier compaction records:`,
      ...bulletSummaries
    ].join('\n');
  }

  private estimateRecordTokens(record: CompactionFrontierRecord): number {
    const ancestry = this.getCoverageAncestry(record);
    const coverageText = ancestry
      .map(ref => `${ref.conversationId}:${ref.startSequenceNumber}-${ref.endSequenceNumber}`)
      .join(' ');
    const rawText = [
      record.summary,
      record.filesReferenced.join(' '),
      record.topics.join(' '),
      coverageText
    ].filter(Boolean).join(' ');

    return Math.ceil(rawText.length / 4) + 40;
  }

  private normalizeRecord(record: CompactedContext): CompactionFrontierRecord {
    const frontierRecord = record as CompactionFrontierRecord;
    const transcriptCoverageAncestry = this.uniqueCoverageRefs(
      frontierRecord.transcriptCoverageAncestry && frontierRecord.transcriptCoverageAncestry.length > 0
        ? frontierRecord.transcriptCoverageAncestry
        : (frontierRecord.transcriptCoverage ? [frontierRecord.transcriptCoverage] : [])
    );

    return {
      ...frontierRecord,
      level: frontierRecord.level ?? 0,
      mergedRecordCount: frontierRecord.mergedRecordCount ?? 1,
      transcriptCoverageAncestry: transcriptCoverageAncestry.length > 0
        ? transcriptCoverageAncestry
        : undefined
    };
  }

  private getCoverageAncestry(record: CompactionFrontierRecord): CompactedTranscriptCoverageRef[] {
    if (record.transcriptCoverageAncestry && record.transcriptCoverageAncestry.length > 0) {
      return record.transcriptCoverageAncestry;
    }

    return record.transcriptCoverage ? [record.transcriptCoverage] : [];
  }

  private uniqueCoverageRefs(
    refs: CompactedTranscriptCoverageRef[]
  ): CompactedTranscriptCoverageRef[] {
    const seen = new Set<string>();
    const unique: CompactedTranscriptCoverageRef[] = [];

    for (const ref of refs) {
      const key = `${ref.conversationId}:${ref.startSequenceNumber}:${ref.endSequenceNumber}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(ref);
    }

    return unique;
  }

  private uniquePreservingOrder(values: string[]): string[] {
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const value of values) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      unique.push(value);
    }

    return unique;
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
  }
}
