jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import { createReadStream } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import readline from 'readline';
import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';
import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';
import type { StorageEvent, TraceAddedEvent, WorkspaceEvent } from '../../src/database/interfaces/StorageEvents';
import {
  SyncCoordinator,
  type IJSONLWriter,
  type ISQLiteCacheManager,
  type SyncState
} from '../../src/database/sync/SyncCoordinator';
import type { SyncResult } from '../../src/types/storage/HybridStorageTypes';

type RebuildProgress = (stage: string, progress: number, total: number) => void;

interface FakeFullRebuildOptions {
  onProgress?: RebuildProgress;
}

interface StartupRebuildHarness {
  hydration: StartupHydrationController;
  initLifecycle: InitLifecycleController;
  syncCoordinator: {
    fullRebuild: jest.Mock<Promise<SyncResult>, [FakeFullRebuildOptions?]>;
  };
  startupRebuildIdleTimeoutMs: number;
}

interface TraceStoreFixture {
  dir: string;
  filePath: string;
  eventCount: number;
  approxBytes: number;
}

const RUN_LARGE_REBUILD_TEST = process.env.RUN_LARGE_REBUILD_TEST === '1';

/**
 * Opt-in large-store harness for issue #158.
 *
 * Default run:
 *   npm test -- --runInBand --runTestsByPath tests/perf/startup-rebuild-large-trace-store.test.ts
 *
 * Stress run:
 *   RUN_LARGE_REBUILD_TEST=1 npm test -- --runInBand --runTestsByPath tests/perf/startup-rebuild-large-trace-store.test.ts
 *   PowerShell: $env:RUN_LARGE_REBUILD_TEST='1'; npm test -- --runInBand --runTestsByPath tests/perf/startup-rebuild-large-trace-store.test.ts
 *
 * Optional stress knobs:
 *   LARGE_REBUILD_EVENT_COUNT=60000
 *   LARGE_REBUILD_PAYLOAD_BYTES=2048
 *   LARGE_REBUILD_PROGRESS_EVERY=500
 *   LARGE_REBUILD_PROGRESS_DELAY_MS=10
 *   LARGE_REBUILD_IDLE_TIMEOUT_MS=1000
 *   REAL_SYNC_REBUILD_EVENT_COUNT=5000
 *
 * The stress defaults generate a trace-heavy workspace stream around the same
 * order of magnitude as the reported 147 MB profile, but only inside a temp
 * directory and only when explicitly requested. The real-SyncCoordinator
 * stress run uses a smaller default because production fullRebuild intentionally
 * delays between workspace batches to reduce memory pressure.
 */
describe('startup rebuild large trace-store harness', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('replays a temp trace-heavy workspace stream without tripping the idle watchdog', async () => {
    const fixture = await createTraceStoreFixture({
      eventCount: 250,
      payloadBytes: 512
    });
    const adapter = makeHarness({ idleTimeoutMs: 25 });
    adapter.hydration.startBlocking();
    adapter.syncCoordinator.fullRebuild.mockImplementation((options) => replayTraceStore(fixture, {
      onProgress: options?.onProgress,
      progressEvery: 25,
      progressDelayMs: 5
    }));

    try {
      await runStartupFullRebuild(adapter, true);

      expect(adapter.syncCoordinator.fullRebuild).toHaveBeenCalledTimes(1);
      const state = adapter.hydration.getState();
      expect(state.phase).toBe('running');
      expect(state.error).toBeUndefined();
    } finally {
      await removeFixture(fixture);
    }
  });

  it('runs real SyncCoordinator.fullRebuild over generated trace-heavy workspace JSONL', async () => {
    const fixture = await createTraceStoreFixture({
      eventCount: 120,
      payloadBytes: 512
    });
    const writer = new TempJsonlWriter(fixture.filePath);
    const cache = new RecordingSQLiteCache();
    const coordinator = new SyncCoordinator(writer, cache);
    const progress: Array<{ stage: string; progress: number; total: number }> = [];

    try {
      const result = await coordinator.fullRebuild({
        batchSize: 10,
        onProgress: (stage, progressValue, total) => {
          progress.push({ stage, progress: progressValue, total });
        }
      });

      expect(result.success).toBe(true);
      expect(result.eventsApplied).toBe(fixture.eventCount);
      expect(cache.workspaces.size).toBe(1);
      expect(cache.sessions.size).toBe(1);
      expect(cache.memoryTraces.size).toBe(120);
      expect(cache.markedEventIds.size).toBe(fixture.eventCount);
      expect(cache.rebuiltFts).toBe(true);
      expect(cache.syncState).not.toBeNull();
      expect(cache.saveCalls).toBe(1);
      expect(progress.some(item => item.stage === 'Processing workspace events')).toBe(true);
      expect(progress).toContainEqual({
        stage: 'Processing workspace events',
        progress: fixture.eventCount,
        total: fixture.eventCount
      });
      expect(progress.at(-1)).toMatchObject({ stage: 'Complete', progress: 1, total: 1 });
    } finally {
      await removeFixture(fixture);
    }
  });

  it('fails deterministically when replay makes no progress', async () => {
    jest.useFakeTimers();
    const adapter = makeHarness({ idleTimeoutMs: 30 });
    adapter.hydration.startBlocking();
    adapter.syncCoordinator.fullRebuild.mockReturnValue(new Promise(() => undefined));

    const pending = runStartupFullRebuild(adapter, true);
    const rejection = expect(pending).rejects.toThrow('made no progress');

    await jest.advanceTimersByTimeAsync(30);
    await rejection;
    expect(adapter.hydration.getState().phase).toBe('error');
  });

  const maybeStressIt = RUN_LARGE_REBUILD_TEST ? it : it.skip;

  maybeStressIt('stress replays a configurable trace-heavy workspace stream', async () => {
    const eventCount = readPositiveIntEnv('LARGE_REBUILD_EVENT_COUNT', 60_000);
    const payloadBytes = readPositiveIntEnv('LARGE_REBUILD_PAYLOAD_BYTES', 2_048);
    const progressEvery = readPositiveIntEnv('LARGE_REBUILD_PROGRESS_EVERY', 500);
    const progressDelayMs = readPositiveIntEnv('LARGE_REBUILD_PROGRESS_DELAY_MS', 10);
    const idleTimeoutMs = readPositiveIntEnv('LARGE_REBUILD_IDLE_TIMEOUT_MS', 1_000);
    const fixture = await createTraceStoreFixture({ eventCount, payloadBytes });
    const adapter = makeHarness({ idleTimeoutMs });
    let replayPromise: Promise<SyncResult> | null = null;
    adapter.hydration.startBlocking();
    adapter.syncCoordinator.fullRebuild.mockImplementation((options) => {
      replayPromise = replayTraceStore(fixture, {
        onProgress: options?.onProgress,
        progressEvery,
        progressDelayMs
      });
      return replayPromise;
    });

    try {
      const started = Date.now();
      await runStartupFullRebuild(adapter, true);
      const durationMs = Date.now() - started;

      expect(adapter.hydration.getState().phase).toBe('running');
      expect(durationMs).toBeGreaterThan(idleTimeoutMs);
      expect(fixture.approxBytes).toBeGreaterThan(eventCount * payloadBytes);
    } finally {
      await replayPromise?.catch(() => undefined);
      await removeFixture(fixture);
    }
  }, 120_000);

  maybeStressIt('stress runs real SyncCoordinator.fullRebuild over generated workspace JSONL', async () => {
    const eventCount = readPositiveIntEnv('REAL_SYNC_REBUILD_EVENT_COUNT', 5_000);
    const payloadBytes = readPositiveIntEnv('LARGE_REBUILD_PAYLOAD_BYTES', 2_048);
    const fixture = await createTraceStoreFixture({ eventCount, payloadBytes });
    const writer = new TempJsonlWriter(fixture.filePath);
    const cache = new RecordingSQLiteCache();
    const coordinator = new SyncCoordinator(writer, cache);
    let workspaceEventProgressCalls = 0;

    try {
      const result = await coordinator.fullRebuild({
        batchSize: 10,
        onProgress: (stage) => {
          if (stage === 'Processing workspace events') {
            workspaceEventProgressCalls += 1;
          }
        }
      });

      expect(result.success).toBe(true);
      expect(result.eventsApplied).toBe(fixture.eventCount);
      expect(cache.memoryTraces.size).toBe(eventCount);
      expect(workspaceEventProgressCalls).toBeGreaterThan(1);
      expect(fixture.approxBytes).toBeGreaterThan(eventCount * payloadBytes);
    } finally {
      await removeFixture(fixture);
    }
  }, 120_000);
});

class TempJsonlWriter implements IJSONLWriter {
  constructor(private readonly workspaceFilePath: string) {}

  getDeviceId(): string {
    return 'local-test-device';
  }

  async listFiles(category: 'workspaces' | 'conversations' | 'tasks'): Promise<string[]> {
    return category === 'workspaces' ? [this.workspaceFilePath] : [];
  }

  async getFileModTime(file: string): Promise<number | null> {
    return file === this.workspaceFilePath ? 1 : null;
  }

  async readEvents<T extends StorageEvent>(file: string): Promise<T[]> {
    if (file !== this.workspaceFilePath) {
      return [];
    }

    const content = await readFile(file, 'utf8');
    return content
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as T);
  }

  async getEventsNotFromDevice<T extends StorageEvent>(
    file: string,
    deviceId: string,
    sinceTimestamp?: number
  ): Promise<T[]> {
    const events = await this.readEvents<T>(file);
    return events.filter(event =>
      event.deviceId !== deviceId
      && (sinceTimestamp === undefined || event.timestamp > sinceTimestamp)
    );
  }
}

class RecordingSQLiteCache implements ISQLiteCacheManager {
  readonly workspaces = new Map<string, unknown[]>();
  readonly sessions = new Map<string, unknown[]>();
  readonly memoryTraces = new Map<string, unknown[]>();
  readonly markedEventIds = new Set<string>();
  syncState: SyncState | null = null;
  rebuiltFts = false;
  saveCalls = 0;

  async getSyncState(deviceId: string): Promise<SyncState | null> {
    return this.syncState?.deviceId === deviceId ? this.syncState : null;
  }

  async updateSyncState(
    deviceId: string,
    lastEventTimestamp: number,
    fileTimestamps: Record<string, number>
  ): Promise<void> {
    this.syncState = { deviceId, lastEventTimestamp, fileTimestamps };
  }

  async isEventApplied(eventId: string): Promise<boolean> {
    return this.markedEventIds.has(eventId);
  }

  async markEventApplied(eventId: string): Promise<void> {
    this.markedEventIds.add(eventId);
  }

  async run(sql: string, params: unknown[] = []): Promise<unknown> {
    if (sql.includes('INTO workspaces')) {
      this.workspaces.set(String(params[0]), params);
      return undefined;
    }
    if (sql.includes('INTO sessions')) {
      this.sessions.set(String(params[0]), params);
      return undefined;
    }
    if (sql.includes('INTO memory_traces')) {
      this.memoryTraces.set(String(params[0]), params);
      return undefined;
    }
    if (sql.includes('DELETE FROM workspaces')) {
      this.workspaces.delete(String(params[0]));
      return undefined;
    }
    if (sql.includes('DELETE FROM states')) {
      return undefined;
    }
    return undefined;
  }

  async query<T>(): Promise<T[]> {
    return [];
  }

  async queryOne<T>(): Promise<T | null> {
    return null;
  }

  async clearAllData(): Promise<void> {
    this.workspaces.clear();
    this.sessions.clear();
    this.memoryTraces.clear();
    this.markedEventIds.clear();
    this.syncState = null;
    this.rebuiltFts = false;
  }

  async rebuildFTSIndexes(): Promise<void> {
    this.rebuiltFts = true;
  }

  async save(): Promise<void> {
    this.saveCalls += 1;
  }
}

function makeHarness(opts: { idleTimeoutMs: number }): StartupRebuildHarness {
  const adapter = Object.create(HybridStorageAdapter.prototype) as unknown as StartupRebuildHarness;
  adapter.hydration = new StartupHydrationController();
  adapter.initLifecycle = new InitLifecycleController();
  adapter.startupRebuildIdleTimeoutMs = opts.idleTimeoutMs;
  adapter.syncCoordinator = {
    fullRebuild: jest.fn()
  };
  return adapter;
}

function runStartupFullRebuild(adapter: StartupRebuildHarness, isBlocking: boolean): Promise<void> {
  return (adapter as unknown as {
    runStartupFullRebuild(isBlockingHydration: boolean): Promise<void>;
  }).runStartupFullRebuild(isBlocking);
}

async function createTraceStoreFixture(opts: {
  eventCount: number;
  payloadBytes: number;
}): Promise<TraceStoreFixture> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexus-large-trace-store-'));
  const workspaceDir = path.join(dir, 'workspaces');
  const filePath = path.join(workspaceDir, 'ws_large.jsonl');
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(filePath, '');

  const payload = 'x'.repeat(opts.payloadBytes);
  let approxBytes = 0;
  const lines: string[] = [];
  lines.push(JSON.stringify(makeWorkspaceCreatedEvent()));
  lines.push(JSON.stringify(makeSessionCreatedEvent()));

  for (let i = 0; i < opts.eventCount; i++) {
    const line = JSON.stringify(makeTraceAddedEvent(i, payload));
    lines.push(line);
    approxBytes += line.length + 1;

    if (lines.length >= 1_000) {
      await writeFile(filePath, `${lines.join('\n')}\n`, { flag: 'a' });
      lines.length = 0;
    }
  }

  if (lines.length > 0) {
    await writeFile(filePath, `${lines.join('\n')}\n`, { flag: 'a' });
  }

  return {
    dir,
    filePath,
    eventCount: opts.eventCount + 2,
    approxBytes
  };
}

async function replayTraceStore(fixture: TraceStoreFixture, opts: {
  onProgress?: RebuildProgress;
  progressEvery: number;
  progressDelayMs: number;
}): Promise<SyncResult> {
  let applied = 0;
  opts.onProgress?.('Processing workspaces', applied, fixture.eventCount);

  const stream = createReadStream(fixture.filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as WorkspaceEvent;
      if (event.type !== 'trace_added'
        && event.type !== 'workspace_created'
        && event.type !== 'session_created') {
        throw new Error(`Unexpected workspace event type: ${event.type}`);
      }
      applied += 1;

      if (applied % opts.progressEvery === 0) {
        opts.onProgress?.('Processing trace events', applied, fixture.eventCount);
        await sleep(opts.progressDelayMs);
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    await new Promise(resolve => stream.closed ? resolve(undefined) : stream.once('close', resolve));
  }

  opts.onProgress?.('Complete', fixture.eventCount, fixture.eventCount);
  return {
    success: true,
    eventsApplied: applied,
    eventsSkipped: 0,
    errors: [],
    lastSyncTimestamp: Date.now(),
    filesProcessed: [fixture.filePath],
    duration: 0
  };
}

async function removeFixture(fixture: TraceStoreFixture): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(fixture.dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function makeWorkspaceCreatedEvent(): WorkspaceEvent {
  return {
    id: 'event_workspace_created',
    type: 'workspace_created',
    deviceId: 'perf-harness',
    timestamp: 1,
    data: {
      id: 'ws_large',
      name: 'Large replay workspace',
      rootFolder: '/',
      created: 1,
      isActive: true
    }
  };
}

function makeSessionCreatedEvent(): WorkspaceEvent {
  return {
    id: 'event_session_created',
    type: 'session_created',
    deviceId: 'perf-harness',
    timestamp: 2,
    workspaceId: 'ws_large',
    data: {
      id: 'session_large',
      name: 'Large replay session',
      startTime: 2
    }
  };
}

function makeTraceAddedEvent(index: number, payload: string): TraceAddedEvent {
  return {
    id: `event_trace_${index}`,
    type: 'trace_added',
    deviceId: 'perf-harness',
    timestamp: 3 + index,
    workspaceId: 'ws_large',
    sessionId: 'session_large',
    data: {
      id: `trace_${index}`,
      content: `Synthetic tool trace ${index}`,
      traceType: 'tool_call',
      metadataJson: JSON.stringify({
        tool: 'toolManager_useTools',
        input: { payload },
        outcome: { success: true }
      })
    }
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
