// Location: src/services/migration/ChromaDataLoader.ts
// Loads data from existing ChromaDB collections for migration to new JSON structure
// Used by: DataMigrationService to read legacy ChromaDB collection data
// Dependencies: FileSystemService for ChromaDB collection file reading

import { FileSystemService } from '../storage/FileSystemService';

type ChromaCollectionItem = Record<string, unknown> & {
  metadata?: unknown;
};

export interface ChromaCollectionData {
  memoryTraces: ChromaCollectionItem[];
  sessions: ChromaCollectionItem[];
  conversations: ChromaCollectionItem[];
  workspaces: ChromaCollectionItem[];
  snapshots: ChromaCollectionItem[];
}

export class ChromaDataLoader {
  private fileSystem: FileSystemService;

  constructor(fileSystem: FileSystemService) {
    this.fileSystem = fileSystem;
  }

  async loadAllCollections(): Promise<ChromaCollectionData> {
    const [memoryTraces, sessions, conversations, workspaces, snapshots] = await Promise.all([
      this.fileSystem.readChromaCollection('memory_traces'),
      this.fileSystem.readChromaCollection('sessions'),
      this.fileSystem.readChromaCollection('chat_conversations'),
      this.fileSystem.readChromaCollection('workspaces'),
      this.fileSystem.readChromaCollection('snapshots')
    ]);

    return {
      memoryTraces: normalizeCollection(memoryTraces),
      sessions: normalizeCollection(sessions),
      conversations: normalizeCollection(conversations),
      workspaces: normalizeCollection(workspaces),
      snapshots: normalizeCollection(snapshots)
    };
  }

  async detectLegacyData(): Promise<boolean> {
    try {
      const collections = await this.loadAllCollections();
      const collectionValues = Object.values(collections) as ChromaCollectionItem[][];
      return collectionValues.some((collection: ChromaCollectionItem[]) =>
        collection.length > 0
      );
    } catch {
      return false;
    }
  }

  /**
   * Get summary statistics about the legacy data
   */
  async getDataSummary(): Promise<{
    totalItems: number;
    collections: Record<string, number>;
    oldestItem?: number;
    newestItem?: number;
  }> {
    const collections = await this.loadAllCollections();

    let totalItems = 0;
    let oldestTimestamp: number | undefined;
    let newestTimestamp: number | undefined;

    const collectionCounts: Record<string, number> = {};

    const collectionEntries = Object.entries(collections) as Array<[keyof ChromaCollectionData, ChromaCollectionItem[]]>;

    for (const [collectionName, items] of collectionEntries) {
      collectionCounts[collectionName] = items.length;
      totalItems += items.length;

      // Find timestamp ranges
      for (const item of items) {
        const timestamp = getTimestamp(getMetadata(item)?.timestamp) ??
                         getTimestamp(getMetadata(item)?.created) ??
                         getTimestamp(getMetadata(item)?.updated);

        if (timestamp) {
          if (!oldestTimestamp || timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp;
          }
          if (!newestTimestamp || timestamp > newestTimestamp) {
            newestTimestamp = timestamp;
          }
        }
      }
    }

    return {
      totalItems,
      collections: collectionCounts,
      oldestItem: oldestTimestamp,
      newestItem: newestTimestamp
    };
  }

  /**
   * Test if ChromaDB collection files are accessible
   */
  async testCollectionAccess(): Promise<{
    accessible: string[];
    missing: string[];
    errors: string[];
  }> {
    const collectionNames = ['memory_traces', 'sessions', 'chat_conversations', 'workspaces', 'snapshots'];
    const accessible: string[] = [];
    const missing: string[] = [];
    const errors: string[] = [];

    for (const collectionName of collectionNames) {
      try {
        const items = await this.fileSystem.readChromaCollection(collectionName);
        if (Array.isArray(items)) {
          accessible.push(collectionName);
        } else {
          missing.push(collectionName);
        }
      } catch (error) {
        errors.push(`${collectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { accessible, missing, errors };
  }
}

function normalizeCollection(collection: unknown[]): ChromaCollectionItem[] {
  return collection.filter(isChromaCollectionItem);
}

function isChromaCollectionItem(value: unknown): value is ChromaCollectionItem {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMetadata(item: ChromaCollectionItem): Record<string, unknown> | undefined {
  return isRecord(item.metadata) ? item.metadata : undefined;
}

function getTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
