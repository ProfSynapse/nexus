import { normalizePath, Vault } from 'obsidian';
import { generateUUID } from '../../utils/uuid';
import { DEFAULT_STORAGE_SETTINGS } from '../../types/plugin/PluginTypes';

export type ArtifactJobKind = 'video' | 'research';
export type ArtifactJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'expired';

export interface ArtifactJobRecord {
  id: string;
  kind: ArtifactJobKind;
  provider: string;
  model?: string;
  providerJobId: string;
  pollingUrl?: string;
  status: ArtifactJobStatus;
  outputPath: string;
  overwrite: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  promptPreview?: string;
  error?: string;
  result?: Record<string, unknown>;
  request?: Record<string, unknown>;
}

export interface CreateArtifactJobInput {
  kind: ArtifactJobKind;
  provider: string;
  model?: string;
  providerJobId: string;
  pollingUrl?: string;
  status?: ArtifactJobStatus;
  outputPath: string;
  overwrite?: boolean;
  expiresAt?: string;
  promptPreview?: string;
  request?: Record<string, unknown>;
}

interface ArtifactJobEvent {
  type: 'upsert';
  id: string;
  timestamp: string;
  record: ArtifactJobRecord;
}

export class ArtifactJobStore {
  private readonly path: string;

  constructor(private readonly vault: Vault, path = `${DEFAULT_STORAGE_SETTINGS.rootPath}/data/artifact-jobs.jsonl`) {
    this.path = normalizePath(path);
  }

  async create(input: CreateArtifactJobInput): Promise<ArtifactJobRecord> {
    const now = new Date().toISOString();
    const record: ArtifactJobRecord = {
      id: `artifact_${generateUUID()}`,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      providerJobId: input.providerJobId,
      pollingUrl: input.pollingUrl,
      status: input.status ?? 'in_progress',
      outputPath: normalizePath(input.outputPath),
      overwrite: input.overwrite === true,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      promptPreview: input.promptPreview,
      request: input.request,
    };

    await this.appendRecord(record);
    return record;
  }

  async update(id: string, patch: Partial<Omit<ArtifactJobRecord, 'id' | 'createdAt'>>): Promise<ArtifactJobRecord> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Artifact job not found: ${id}`);
    }

    const record: ArtifactJobRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      outputPath: patch.outputPath ? normalizePath(patch.outputPath) : existing.outputPath,
      updatedAt: new Date().toISOString(),
    };

    await this.appendRecord(record);
    return record;
  }

  async get(id: string): Promise<ArtifactJobRecord | null> {
    return (await this.readAll()).get(id) ?? null;
  }

  async list(): Promise<ArtifactJobRecord[]> {
    return Array.from((await this.readAll()).values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async appendRecord(record: ArtifactJobRecord): Promise<void> {
    await this.ensureParentDirectory();
    const event: ArtifactJobEvent = {
      type: 'upsert',
      id: record.id,
      timestamp: new Date().toISOString(),
      record,
    };
    await this.vault.adapter.append(this.path, `${JSON.stringify(event)}\n`);
  }

  private async readAll(): Promise<Map<string, ArtifactJobRecord>> {
    if (!(await this.vault.adapter.exists(this.path))) {
      return new Map();
    }

    const content = await this.vault.adapter.read(this.path);
    const records = new Map<string, ArtifactJobRecord>();

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const event = this.parseEvent(trimmed);
      if (!event) {
        continue;
      }

      records.set(event.id, event.record);
    }

    return records;
  }

  private parseEvent(line: string): ArtifactJobEvent | null {
    try {
      const value = JSON.parse(line) as unknown;
      if (!isArtifactJobEvent(value)) {
        return null;
      }
      return value;
    } catch {
      return null;
    }
  }

  private async ensureParentDirectory(): Promise<void> {
    const slashIndex = this.path.lastIndexOf('/');
    if (slashIndex <= 0) {
      return;
    }

    const directory = this.path.slice(0, slashIndex);
    const parts = directory.split('/').filter(part => part.length > 0);
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await this.vault.adapter.exists(current)) {
        continue;
      }
      await this.vault.adapter.mkdir(current);
    }
  }
}

function isArtifactJobEvent(value: unknown): value is ArtifactJobEvent {
  if (!isRecord(value) || value.type !== 'upsert' || typeof value.id !== 'string' || !isRecord(value.record)) {
    return false;
  }

  const record = value.record;
  return typeof record.id === 'string'
    && typeof record.kind === 'string'
    && typeof record.provider === 'string'
    && typeof record.providerJobId === 'string'
    && typeof record.status === 'string'
    && typeof record.outputPath === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
