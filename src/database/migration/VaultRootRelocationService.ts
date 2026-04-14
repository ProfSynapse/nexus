import { App, normalizePath } from 'obsidian';

import {
  resolveVaultRoot,
  type VaultRootResolution
} from '../storage/VaultRootResolver';
import {
  VaultEventStore,
  type EventStreamCategory
} from '../storage/vaultRoot/VaultEventStore';
import {
  stableEventSignature,
  EVENT_STREAM_CATEGORIES,
  parseEventStreamPath
} from '../storage/vaultRoot/EventStreamUtilities';

export interface VaultRootRelocationServiceOptions {
  app: App;
  sourceStore: VaultEventStore;
  targetRootPath: string;
  maxShardBytes: number;
  categories?: EventStreamCategory[];
}

export interface VaultRootRelocationConflict {
  category: EventStreamCategory;
  streamPath: string;
  eventId?: string;
  reason:
    | 'invalid-target-root'
    | 'source-content-conflict'
    | 'destination-content-conflict'
    | 'verification-failed';
  message: string;
  sourceEvent?: Record<string, unknown>;
  destinationEvent?: Record<string, unknown>;
}

export interface VaultRootRelocationFileResult {
  category: EventStreamCategory;
  streamPath: string;
  sourceEventCount: number;
  destinationEventCountBefore: number;
  destinationEventCountAfter: number;
  copiedEventCount: number;
  skippedEventCount: number;
  verified: boolean;
  conflicts: VaultRootRelocationConflict[];
}

export interface VaultRootRelocationResult {
  success: boolean;
  verified: boolean;
  relation: 'identical' | 'strict-superset' | 'conflict';
  durationMs: number;
  sourceRootPath: string;
  destinationRootPath: string;
  sourceStreamCount: number;
  destinationStreamCountBefore: number;
  destinationStreamCountAfter: number;
  copiedEventCount: number;
  skippedEventCount: number;
  fileResults: VaultRootRelocationFileResult[];
  conflicts: VaultRootRelocationConflict[];
  errors: string[];
  destinationStore?: VaultEventStore;
}

type EventEntry = {
  event: Record<string, unknown>;
  signature: string;
};

const DEFAULT_CATEGORIES: EventStreamCategory[] = EVENT_STREAM_CATEGORIES;

function buildEventMap(
  events: Record<string, unknown>[],
  category: EventStreamCategory,
  streamPath: string,
  origin: 'source' | 'destination'
): { eventMap: Map<string, EventEntry>; conflicts: VaultRootRelocationConflict[] } {
  const eventMap = new Map<string, EventEntry>();
  const conflicts: VaultRootRelocationConflict[] = [];

  for (const event of events) {
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) {
      conflicts.push({
        category,
        streamPath,
        reason: `${origin}-content-conflict`,
        message: `${origin === 'source' ? 'Source' : 'Destination'} content for ${streamPath} is missing an event id.`,
        sourceEvent: origin === 'source' ? event : undefined,
        destinationEvent: origin === 'destination' ? event : undefined
      });
      continue;
    }

    const signature = stableEventSignature(event);
    const existing = eventMap.get(id);
    if (existing) {
      if (existing.signature !== signature) {
        conflicts.push({
          category,
          streamPath,
          eventId: id,
          reason: `${origin}-content-conflict`,
          message: `${origin === 'source' ? 'Source' : 'Destination'} content for ${streamPath} contains conflicting versions of ${id}.`,
          sourceEvent: origin === 'source' ? existing.event : undefined,
          destinationEvent: origin === 'destination' ? existing.event : undefined
        });
      }
      continue;
    }

    eventMap.set(id, { event, signature });
  }

  return { eventMap, conflicts };
}

export class VaultRootRelocationService {
  private readonly app: App;
  private readonly sourceStore: VaultEventStore;
  private readonly targetRootPath: string;
  private readonly maxShardBytes: number;
  private readonly categories: EventStreamCategory[];

  constructor(options: VaultRootRelocationServiceOptions) {
    this.app = options.app;
    this.sourceStore = options.sourceStore;
    this.targetRootPath = normalizePath(options.targetRootPath);
    this.maxShardBytes = Math.max(1, Math.floor(options.maxShardBytes));
    this.categories = options.categories && options.categories.length > 0
      ? options.categories
      : DEFAULT_CATEGORIES;
  }

  async relocateVaultRoot(): Promise<VaultRootRelocationResult> {
    const startedAt = Date.now();
    const sourceRootPath = this.sourceStore.getRootPath();
    const resolution = resolveVaultRoot({
      storage: {
        rootPath: this.targetRootPath,
        maxShardBytes: this.maxShardBytes
      }
    }, {
      configDir: this.app.vault.configDir
    });

    if (!resolution.validation.isValid) {
      return {
        success: false,
        verified: false,
        relation: 'conflict',
        durationMs: Date.now() - startedAt,
        sourceRootPath,
        destinationRootPath: resolution.dataPath,
        sourceStreamCount: 0,
        destinationStreamCountBefore: 0,
        destinationStreamCountAfter: 0,
        copiedEventCount: 0,
        skippedEventCount: 0,
        fileResults: [],
        conflicts: resolution.validation.errors.map(error => ({
          category: 'conversations',
          streamPath: '',
          reason: 'invalid-target-root',
          message: error
        })),
        errors: [...resolution.validation.errors],
        destinationStore: undefined
      };
    }

    const destinationRootPath = resolution.dataPath;
    if (normalizePath(sourceRootPath) === normalizePath(destinationRootPath)) {
      return {
        success: true,
        verified: true,
        relation: 'identical',
        durationMs: Date.now() - startedAt,
        sourceRootPath,
        destinationRootPath,
        sourceStreamCount: 0,
        destinationStreamCountBefore: 0,
        destinationStreamCountAfter: 0,
        copiedEventCount: 0,
        skippedEventCount: 0,
        fileResults: [],
        conflicts: [],
        errors: [],
        destinationStore: this.sourceStore
      };
    }

    const destinationStore = new VaultEventStore({
      app: this.app,
      resolution: {
        resolvedPath: resolution.resolvedPath,
        dataPath: resolution.dataPath,
        maxShardBytes: resolution.maxShardBytes
      } satisfies Pick<VaultRootResolution, 'resolvedPath' | 'dataPath' | 'maxShardBytes'>
    });

    const sourceFiles = await this.listStreamFiles(this.sourceStore);
    const destinationFilesBefore = await this.listStreamFiles(destinationStore);
    const sourceFileSet = new Set(sourceFiles);
    const fileResults: VaultRootRelocationFileResult[] = [];
    const conflicts: VaultRootRelocationConflict[] = [];
    const errors: string[] = [];
    let sourceStreamCount = sourceFiles.length;
    let destinationStreamCountBefore = destinationFilesBefore.length;
    let destinationStreamCountAfter = destinationStreamCountBefore;
    let copiedEventCount = 0;
    let skippedEventCount = 0;
    let relation: VaultRootRelocationResult['relation'] = 'identical';

    const preflightPlans: Array<{
      category: EventStreamCategory;
      streamPath: string;
      sourceEvents: Record<string, unknown>[];
      destinationEventsBefore: Record<string, unknown>[];
      sourceMap: Map<string, EventEntry>;
      destinationMapBefore: Map<string, EventEntry>;
      missingEvents: Record<string, unknown>[];
      destinationHasExtraEvents: boolean;
      destinationHadFile: boolean;
    }> = [];

    for (const streamPath of sourceFiles) {
      const category = this.getCategoryFromStreamPath(streamPath);
      const sourceEvents = await this.sourceStore.readEvents<Record<string, unknown>>(streamPath);
      const destinationEventsBefore = await destinationStore.readEvents<Record<string, unknown>>(streamPath);

      const sourceAnalysis = buildEventMap(sourceEvents, category, streamPath, 'source');
      const destinationAnalysis = buildEventMap(destinationEventsBefore, category, streamPath, 'destination');
      const streamConflicts = [...sourceAnalysis.conflicts, ...destinationAnalysis.conflicts];

      for (const [eventId, sourceEntry] of sourceAnalysis.eventMap.entries()) {
        const destinationEntry = destinationAnalysis.eventMap.get(eventId);
        if (destinationEntry && destinationEntry.signature !== sourceEntry.signature) {
          streamConflicts.push({
            category,
            streamPath,
            eventId,
            reason: 'destination-content-conflict',
            message: `Destination content for ${streamPath} conflicts with source event ${eventId}.`,
            sourceEvent: sourceEntry.event,
            destinationEvent: destinationEntry.event
          });
        }
      }

      if (streamConflicts.length > 0) {
        conflicts.push(...streamConflicts);
        fileResults.push({
          category,
          streamPath,
          sourceEventCount: sourceAnalysis.eventMap.size,
          destinationEventCountBefore: destinationAnalysis.eventMap.size,
          destinationEventCountAfter: destinationAnalysis.eventMap.size,
          copiedEventCount: 0,
          skippedEventCount: 0,
          verified: false,
          conflicts: streamConflicts
        });
        continue;
      }

      const missingEvents = Array.from(sourceAnalysis.eventMap.entries())
        .filter(([eventId]) => !destinationAnalysis.eventMap.has(eventId))
        .map(([, entry]) => entry.event);

      preflightPlans.push({
        category,
        streamPath,
        sourceEvents,
        destinationEventsBefore,
        sourceMap: sourceAnalysis.eventMap,
        destinationMapBefore: destinationAnalysis.eventMap,
        missingEvents,
        destinationHasExtraEvents: destinationAnalysis.eventMap.size > sourceAnalysis.eventMap.size,
        destinationHadFile: destinationEventsBefore.length > 0
      });
    }

    if (conflicts.length > 0 || errors.length > 0) {
      return {
        success: false,
        verified: false,
        relation: 'conflict',
        durationMs: Date.now() - startedAt,
        sourceRootPath,
        destinationRootPath,
        sourceStreamCount,
        destinationStreamCountBefore,
        destinationStreamCountAfter,
        copiedEventCount,
        skippedEventCount,
        fileResults,
        conflicts,
        errors,
        destinationStore: undefined
      };
    }

    const destinationHasExtraFiles = destinationFilesBefore.some(filePath => !sourceFileSet.has(filePath));
    if (destinationHasExtraFiles) {
      relation = 'strict-superset';
    }

    for (const plan of preflightPlans) {
      if (plan.destinationHasExtraEvents || plan.destinationHadFile && plan.destinationMapBefore.size > 0 && plan.destinationMapBefore.size > plan.sourceMap.size) {
        relation = 'strict-superset';
      }

      if (plan.missingEvents.length > 0) {
        await destinationStore.appendEvents(plan.streamPath, plan.missingEvents);
        copiedEventCount += plan.missingEvents.length;
      }

      skippedEventCount += plan.sourceMap.size - plan.missingEvents.length;
    }

    const destinationFilesAfter = await this.listStreamFiles(destinationStore);
    destinationStreamCountAfter = destinationFilesAfter.length;
    if (destinationFilesAfter.some(filePath => !sourceFileSet.has(filePath))) {
      relation = 'strict-superset';
    }

    for (const plan of preflightPlans) {
      const destinationEventsAfter = await destinationStore.readEvents<Record<string, unknown>>(plan.streamPath);
      const destinationAnalysisAfter = buildEventMap(
        destinationEventsAfter,
        plan.category,
        plan.streamPath,
        'destination'
      );
      const streamConflicts: VaultRootRelocationConflict[] = [];

      if (destinationAnalysisAfter.conflicts.length > 0) {
        streamConflicts.push(...destinationAnalysisAfter.conflicts);
      }

      for (const [eventId, sourceEntry] of plan.sourceMap.entries()) {
        const destinationEntry = destinationAnalysisAfter.eventMap.get(eventId);
        if (!destinationEntry || destinationEntry.signature !== sourceEntry.signature) {
          streamConflicts.push({
            category: plan.category,
            streamPath: plan.streamPath,
            eventId,
            reason: 'verification-failed',
            message: `Destination content for ${plan.streamPath} failed verification for ${eventId}.`,
            sourceEvent: sourceEntry.event,
            destinationEvent: destinationEntry?.event
          });
        }
      }

      const fileResult: VaultRootRelocationFileResult = {
        category: plan.category,
        streamPath: plan.streamPath,
        sourceEventCount: plan.sourceMap.size,
        destinationEventCountBefore: plan.destinationMapBefore.size,
        destinationEventCountAfter: destinationAnalysisAfter.eventMap.size,
        copiedEventCount: plan.missingEvents.length,
        skippedEventCount: plan.sourceMap.size - plan.missingEvents.length,
        verified: streamConflicts.length === 0,
        conflicts: streamConflicts
      };

      fileResults.push(fileResult);
      if (streamConflicts.length > 0) {
        conflicts.push(...streamConflicts);
      }

      if (destinationAnalysisAfter.eventMap.size > plan.sourceMap.size) {
        relation = 'strict-superset';
      }
    }

    const verified = conflicts.length === 0 && errors.length === 0 && fileResults.every(result => result.verified);
    if (!verified) {
      return {
        success: false,
        verified: false,
        relation: 'conflict',
        durationMs: Date.now() - startedAt,
        sourceRootPath,
        destinationRootPath,
        sourceStreamCount,
        destinationStreamCountBefore,
        destinationStreamCountAfter,
        copiedEventCount,
        skippedEventCount,
        fileResults,
        conflicts,
        errors,
        destinationStore: undefined
      };
    }

    if (relation === 'identical' && destinationHasExtraFiles) {
      relation = 'strict-superset';
    }

    await destinationStore.writeStorageManifest();

    return {
      success: true,
      verified: true,
      relation,
      durationMs: Date.now() - startedAt,
      sourceRootPath,
      destinationRootPath,
      sourceStreamCount,
      destinationStreamCountBefore,
      destinationStreamCountAfter,
      copiedEventCount,
      skippedEventCount,
      fileResults,
      conflicts: [],
      errors: [],
      destinationStore
    };
  }

  private async listStreamFiles(store: VaultEventStore): Promise<string[]> {
    const files = new Set<string>();

    for (const category of this.categories) {
      const categoryFiles = await store.listFiles(category);
      for (const filePath of categoryFiles) {
        files.add(normalizePath(filePath));
      }
    }

    return Array.from(files).sort((left, right) => left.localeCompare(right));
  }

  private getCategoryFromStreamPath(
    streamPath: string
  ): EventStreamCategory {
    return parseEventStreamPath(streamPath)?.category ?? 'conversations';
  }
}
