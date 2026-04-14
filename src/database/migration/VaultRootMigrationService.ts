import { App, normalizePath } from 'obsidian';

import {
  VaultEventStore,
  type EventStreamCategory
} from '../storage/vaultRoot/VaultEventStore';
import {
  buildEventStreamPath as buildEventStreamPathUtil,
  stableEventSignature,
  EVENT_STREAM_CATEGORIES,
  parseEventStreamPath
} from '../storage/vaultRoot/EventStreamUtilities';
import { appendMobileMarkdownLog } from './MobileMarkdownLogger';

const MIGRATION_TRACE_PREFIX = '[NexusMigrationTrace]';

function traceMigration(message: string, details?: unknown): void {
  if (details !== undefined) {
    console.error(`${MIGRATION_TRACE_PREFIX} ${message}`, details);
    return;
  }

  console.error(`${MIGRATION_TRACE_PREFIX} ${message}`);
}

export interface VaultRootMigrationServiceOptions {
  app: App;
  vaultEventStore: VaultEventStore;
  legacyRoots: string[];
  categories?: EventStreamCategory[];
  mobileLogPath?: string;
}

export interface VaultRootMigrationSourceFile {
  rootPath: string;
  relativePath: string;
  streamPath: string;
  size: number | null;
  modTime: number | null;
}

export interface VaultRootMigrationConflict {
  category: EventStreamCategory;
  streamPath: string;
  eventId?: string;
  reason:
    | 'invalid-json'
    | 'missing-id'
    | 'legacy-content-conflict'
    | 'vault-content-conflict';
  message: string;
  sourceFiles: VaultRootMigrationSourceFile[];
  legacyEvent?: Record<string, unknown>;
  vaultEvent?: Record<string, unknown>;
}

export interface VaultRootMigrationFileResult {
  category: EventStreamCategory;
  streamPath: string;
  sourceFiles: VaultRootMigrationSourceFile[];
  legacyEventCount: number;
  vaultEventCountBefore: number;
  vaultEventCountAfter: number;
  copiedEventCount: number;
  skippedEventCount: number;
  verified: boolean;
  conflicts: VaultRootMigrationConflict[];
  errors: string[];
}

export interface VaultRootMigrationResult {
  needed: boolean;
  success: boolean;
  verified: boolean;
  durationMs: number;
  filesScanned: number;
  filesProcessed: number;
  filesCopied: number;
  filesVerified: number;
  filesConflicted: number;
  eventsCopied: number;
  eventsSkipped: number;
  conflicts: VaultRootMigrationConflict[];
  fileResults: VaultRootMigrationFileResult[];
  errors: string[];
  message: string;
}

interface LegacyEventRecord {
  event: Record<string, unknown>;
  id: string;
  signature: string;
  sourceFile: VaultRootMigrationSourceFile;
  lineNumber: number;
}

interface LegacyFileSnapshot {
  category: EventStreamCategory;
  streamPath: string;
  sourceFile: VaultRootMigrationSourceFile;
  events: LegacyEventRecord[];
  errors: string[];
}

const DEFAULT_CATEGORIES: EventStreamCategory[] = EVENT_STREAM_CATEGORIES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(
    new Set(
      paths
        .map(path => normalizePath(path).replace(/^\/+|\/+$/g, ''))
        .filter(path => path.length > 0)
    )
  );
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
}

function getLeafName(path: string): string {
  const normalized = normalizePath(path);
  const lastSlashIndex = normalized.lastIndexOf('/');
  return lastSlashIndex === -1 ? normalized : normalized.slice(lastSlashIndex + 1);
}

function parseJsonlContent(content: string): { events: Record<string, unknown>[]; errors: string[] } {
  if (!content.trim()) {
    return { events: [], errors: [] };
  }

  const events: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        errors.push(`Line ${index + 1}: JSON value is not an object.`);
        continue;
      }
      events.push(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Line ${index + 1}: ${message}`);
    }
  }

  return { events, errors };
}

function buildVaultSourceFile(
  rootPath: string,
  category: EventStreamCategory,
  relativePath: string,
  stat: { size: number; mtime: number | undefined } | null
): VaultRootMigrationSourceFile {
  return {
    rootPath,
    relativePath,
    streamPath: buildEventStreamPathUtil(
      category,
      getLeafName(relativePath).slice(0, -'.jsonl'.length)
    ),
    size: stat?.size ?? null,
    modTime: stat?.mtime ?? null
  };
}

export class VaultRootMigrationService {
  private readonly app: App;
  private readonly vaultEventStore: VaultEventStore;
  private readonly legacyRoots: string[];
  private readonly categories: EventStreamCategory[];
  private readonly mobileLogPath?: string;

  constructor(options: VaultRootMigrationServiceOptions) {
    this.app = options.app;
    this.vaultEventStore = options.vaultEventStore;
    this.legacyRoots = uniquePaths(options.legacyRoots);
    this.categories = options.categories && options.categories.length > 0
      ? options.categories
      : DEFAULT_CATEGORIES;
    this.mobileLogPath = options.mobileLogPath;
  }

  private trace(message: string, details?: unknown): void {
    traceMigration(message, details);
    appendMobileMarkdownLog(this.app, this.mobileLogPath, message, details);
  }

  async backfillLegacyRoots(): Promise<VaultRootMigrationResult> {
    const startedAt = Date.now();
    const fileResults: VaultRootMigrationFileResult[] = [];
    const conflicts: VaultRootMigrationConflict[] = [];
    const errors: string[] = [];
    let filesScanned = 0;
    let filesCopied = 0;
    let filesVerified = 0;
    let filesConflicted = 0;
    let eventsCopied = 0;
    let eventsSkipped = 0;
    let needed = false;
    let success = true;
    let verified = true;

    const legacySnapshots = await this.collectLegacySnapshots();
    const eventPaths = Array.from(legacySnapshots.keys()).sort((left, right) => left.localeCompare(right));
    this.trace('legacy snapshots collected', {
      streamCount: eventPaths.length
    });

    filesScanned = Array.from(legacySnapshots.values()).reduce((total, snapshots) => total + snapshots.length, 0);
    needed = filesScanned > 0;

    const streamTotal = eventPaths.length;

    for (let streamIndex = 0; streamIndex < streamTotal; streamIndex += 1) {
      const streamPath = eventPaths[streamIndex];
      const snapshots = legacySnapshots.get(streamPath) ?? [];
      let result: VaultRootMigrationFileResult;

      try {
        result = await this.backfillFile(streamPath, snapshots);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.trace('backfill stream failed', {
          streamIndex: streamIndex + 1,
          streamTotal,
          streamPath,
          snapshotCount: snapshots.length,
          message
        });
        throw error;
      }

      fileResults.push(result);
      conflicts.push(...result.conflicts);
      errors.push(...result.errors);
      eventsCopied += result.copiedEventCount;
      eventsSkipped += result.skippedEventCount;

      if (result.copiedEventCount > 0) {
        filesCopied += 1;
      }
      if (result.verified) {
        filesVerified += 1;
      }
      if (result.conflicts.length > 0) {
        filesConflicted += 1;
        success = false;
        verified = false;
      }
      if (result.errors.length > 0) {
        success = false;
        verified = false;
      }
      this.trace('backfill stream complete', {
        streamIndex: streamIndex + 1,
        streamTotal,
        streamPath,
        snapshotCount: snapshots.length,
        copiedEventCount: result.copiedEventCount,
        skippedEventCount: result.skippedEventCount,
        verified: result.verified,
        conflictCount: result.conflicts.length,
        errorCount: result.errors.length
      });
    }

    if (errors.length > 0) {
      success = false;
      verified = false;
    }

    const result: VaultRootMigrationResult = !needed
      ? {
        needed: false,
        success: true,
        verified: true,
        durationMs: Date.now() - startedAt,
        filesScanned: 0,
        filesProcessed: 0,
        filesCopied: 0,
        filesVerified: 0,
        filesConflicted: 0,
        eventsCopied: 0,
        eventsSkipped: 0,
        conflicts: [],
        fileResults: [],
        errors: [],
        message: 'No legacy JSONL files were found in configured roots.'
      }
      : {
        needed,
        success,
        verified,
        durationMs: Date.now() - startedAt,
        filesScanned,
        filesProcessed: fileResults.length,
        filesCopied,
        filesVerified,
        filesConflicted,
        eventsCopied,
        eventsSkipped,
        conflicts,
        fileResults,
        errors,
        message: success
          ? (eventsCopied > 0
            ? `Backfilled ${eventsCopied} legacy events into vault-root event storage.`
            : 'Vault-root event storage already contains all legacy events.')
          : 'Backfill completed with conflicts or errors.'
      };

    this.trace('backfillLegacyRoots complete', {
      needed: result.needed,
      success: result.success,
      verified: result.verified,
      filesScanned: result.filesScanned,
      filesProcessed: result.filesProcessed,
      eventsCopied: result.eventsCopied,
      eventsSkipped: result.eventsSkipped
    });
    return result;
  }

  private async collectLegacySnapshots(): Promise<Map<string, LegacyFileSnapshot[]>> {
    const snapshotsByStreamPath = new Map<string, LegacyFileSnapshot[]>();

    for (const rootPath of this.legacyRoots) {
      for (const category of this.categories) {
        const categoryRoot = normalizePath(`${rootPath}/${category}`);
        if (!(await this.app.vault.adapter.exists(categoryRoot))) {
          continue;
        }

        const listing = await this.app.vault.adapter.list(categoryRoot);
        const files = listing.files
          .map(filePath => normalizePath(filePath))
          .filter(filePath => getParentPath(filePath) === categoryRoot && filePath.endsWith('.jsonl'))
          .sort((left, right) => left.localeCompare(right));
        for (const filePath of files) {
          const snapshot = await this.readLegacyFile(rootPath, category, filePath);
          const existing = snapshotsByStreamPath.get(snapshot.streamPath) ?? [];
          snapshotsByStreamPath.set(snapshot.streamPath, [...existing, snapshot]);
        }
      }
    }

    return snapshotsByStreamPath;
  }

  private async readLegacyFile(
    rootPath: string,
    category: EventStreamCategory,
    filePath: string
  ): Promise<LegacyFileSnapshot> {
    const content = await this.app.vault.adapter.read(filePath);
    const stat = await this.app.vault.adapter.stat(filePath);
    const sourceFile = buildVaultSourceFile(rootPath, category, filePath, stat);
    const parsed = parseJsonlContent(content);
    const errors = [...parsed.errors];
    const events: LegacyEventRecord[] = [];

    for (let index = 0; index < parsed.events.length; index += 1) {
      const event = parsed.events[index];
      const id = typeof event.id === 'string' ? event.id : '';
      if (!id) {
        errors.push(`Line ${index + 1}: missing event id.`);
        continue;
      }

      events.push({
        event,
        id,
        signature: stableEventSignature(event),
        sourceFile,
        lineNumber: index + 1
      });
    }

    return {
      category,
      streamPath: sourceFile.streamPath,
      sourceFile,
      events,
      errors
    };
  }

  private async backfillFile(
    streamPath: string,
    snapshots: LegacyFileSnapshot[]
  ): Promise<VaultRootMigrationFileResult> {
    const category = this.getCategoryFromStreamPath(streamPath);
    const sourceFiles = snapshots.map(snapshot => snapshot.sourceFile);
    const errors: string[] = [];
    const conflicts: VaultRootMigrationConflict[] = [];

    const legacyEvents = new Map<string, LegacyEventRecord>();
    const legacyOrderedEvents: LegacyEventRecord[] = [];

    for (const snapshot of snapshots) {
      errors.push(...snapshot.errors);

      for (const entry of snapshot.events) {
        const existing = legacyEvents.get(entry.id);
        if (existing) {
          if (existing.signature !== entry.signature) {
            conflicts.push({
              category,
              streamPath,
              eventId: entry.id,
              reason: 'legacy-content-conflict',
              message: `Legacy roots disagree for ${streamPath} event ${entry.id}.`,
              sourceFiles,
              legacyEvent: entry.event
            });
          }
          continue;
        }

        legacyEvents.set(entry.id, entry);
        legacyOrderedEvents.push(entry);
      }
    }

    if (errors.length > 0 || conflicts.length > 0) {
      return {
        category,
        streamPath,
        sourceFiles,
        legacyEventCount: legacyOrderedEvents.length,
        vaultEventCountBefore: 0,
        vaultEventCountAfter: 0,
        copiedEventCount: 0,
        skippedEventCount: 0,
        verified: false,
        conflicts,
        errors
      };
    }

    const vaultBefore = await this.vaultEventStore.readEvents<Record<string, unknown>>(streamPath);
    const vaultBeforeMap = this.buildEventMap(vaultBefore, streamPath, category, sourceFiles, conflicts);

    if (errors.length > 0 || conflicts.length > 0) {
      return {
        category,
        streamPath,
        sourceFiles,
        legacyEventCount: legacyOrderedEvents.length,
        vaultEventCountBefore: vaultBefore.length,
        vaultEventCountAfter: vaultBefore.length,
        copiedEventCount: 0,
        skippedEventCount: 0,
        verified: false,
        conflicts,
        errors
      };
    }

    const missingEvents: Record<string, unknown>[] = [];
    for (const entry of legacyOrderedEvents) {
      const vaultEntry = vaultBeforeMap.get(entry.id);
      if (!vaultEntry) {
        missingEvents.push(entry.event);
        continue;
      }

      if (vaultEntry.signature !== entry.signature) {
        conflicts.push({
          category,
          streamPath,
          eventId: entry.id,
          reason: 'vault-content-conflict',
          message: `Vault-root content differs for ${streamPath} event ${entry.id}.`,
          sourceFiles,
          legacyEvent: entry.event,
          vaultEvent: vaultEntry.event
        });
      }
    }

    if (conflicts.length > 0) {
      return {
        category,
        streamPath,
        sourceFiles,
        legacyEventCount: legacyOrderedEvents.length,
        vaultEventCountBefore: vaultBefore.length,
        vaultEventCountAfter: vaultBefore.length,
        copiedEventCount: 0,
        skippedEventCount: legacyOrderedEvents.length,
        verified: false,
        conflicts,
        errors
      };
    }

    if (missingEvents.length > 0) {
      await this.vaultEventStore.appendEvents(streamPath, missingEvents);
    }

    const vaultAfter = await this.vaultEventStore.readEvents<Record<string, unknown>>(streamPath);
    const vaultAfterMap = this.buildEventMap(vaultAfter, streamPath, category, sourceFiles, conflicts);

    if (errors.length > 0 || conflicts.length > 0) {
      return {
        category,
        streamPath,
        sourceFiles,
        legacyEventCount: legacyOrderedEvents.length,
        vaultEventCountBefore: vaultBefore.length,
        vaultEventCountAfter: vaultAfter.length,
        copiedEventCount: missingEvents.length,
        skippedEventCount: legacyOrderedEvents.length - missingEvents.length,
        verified: false,
        conflicts,
        errors
      };
    }

    let verified = true;
    for (const entry of legacyOrderedEvents) {
      const vaultEntry = vaultAfterMap.get(entry.id);
      if (!vaultEntry || vaultEntry.signature !== entry.signature) {
        verified = false;
        conflicts.push({
          category,
          streamPath,
          eventId: entry.id,
          reason: 'vault-content-conflict',
          message: `Vault-root content failed verification for ${streamPath} event ${entry.id}.`,
          sourceFiles,
          legacyEvent: entry.event,
          vaultEvent: vaultEntry?.event
        });
      }
    }

    return {
      category,
      streamPath,
      sourceFiles,
      legacyEventCount: legacyOrderedEvents.length,
      vaultEventCountBefore: vaultBefore.length,
      vaultEventCountAfter: vaultAfter.length,
      copiedEventCount: missingEvents.length,
      skippedEventCount: legacyOrderedEvents.length - missingEvents.length,
      verified,
      conflicts,
      errors
    };
  }

  private buildEventMap(
    events: Record<string, unknown>[],
    streamPath: string,
    category: EventStreamCategory,
    sourceFiles: VaultRootMigrationSourceFile[],
    conflicts: VaultRootMigrationConflict[]
  ): Map<string, { event: Record<string, unknown>; signature: string }> {
    const eventMap = new Map<string, { event: Record<string, unknown>; signature: string }>();

    for (const event of events) {
      const id = typeof event.id === 'string' ? event.id : '';
      if (!id) {
        conflicts.push({
          category,
          streamPath,
          reason: 'missing-id',
          message: `Vault-root content for ${streamPath} is missing an event id.`,
          sourceFiles,
          vaultEvent: event
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
            reason: 'vault-content-conflict',
            message: `Vault-root content for ${streamPath} contains conflicting event versions for ${id}.`,
            sourceFiles,
            vaultEvent: event
          });
        }
        continue;
      }

      eventMap.set(id, { event, signature });
    }

    return eventMap;
  }

  private getCategoryFromStreamPath(
    streamPath: string
  ): EventStreamCategory {
    return parseEventStreamPath(streamPath)?.category ?? 'conversations';
  }
}
