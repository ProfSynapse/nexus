import { Platform } from 'obsidian';
import { TraceRepository } from '../../src/database/repositories/TraceRepository';
import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import { WorkspaceMigrator } from '../../src/database/migration/WorkspaceMigrator';
import type { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import type { TraceAddedEvent } from '../../src/database/interfaces/StorageEvents';
import { MAX_TRACE_METADATA_BYTES, utf8ByteLength } from '../../src/services/trace/TraceMetadataCompactor';

/**
 * Every way a trace reaches storage must come out bounded:
 * - written live (TraceRepository.addTrace — every trace writer ends there),
 * - replayed or synced from another device into the cache (WorkspaceEventApplier),
 * - imported from a pre-5.x workspace file (WorkspaceMigrator).
 *
 * The payload is shaped like the real one that produced 4.9 MB shards: a
 * `content write` whose file body the CLI spliced into the command string.
 */
function splicedWriteCommand(bodyBytes: number): string {
  const unit = '{"row":"value with \\"quotes\\" and a C:\\\\path"}\n';
  const body = unit.repeat(Math.ceil(bodyBytes / unit.length)).slice(0, bodyBytes);
  const escaped = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  return `content write --path "QA Evidence/native_after.json" --content "${escaped}"`;
}

function useToolsMetadata(tool: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tool: { id: 'toolManager_useTools', agent: 'toolManager', mode: 'useTools' },
    context: { workspaceId: 'ws-1', sessionId: 'session-1', memory: 'QA run.', goal: 'Save evidence.' },
    input: { arguments: { tool } },
    outcome: { success: true }
  };
}

describe('TraceRepository.addTrace', () => {
  function makeRepository() {
    const appended: Array<{ path: string; event: TraceAddedEvent }> = [];
    const sqliteRuns: Array<{ sql: string; params: unknown[] }> = [];
    const deps = {
      sqliteCache: {
        run: jest.fn(async (sql: string, params: unknown[]) => { sqliteRuns.push({ sql, params }); }),
        query: jest.fn().mockResolvedValue([]),
        queryOne: jest.fn(),
        transaction: jest.fn((fn: () => Promise<unknown>) => fn())
      },
      jsonlWriter: {
        appendEvent: jest.fn(async (path: string, event: TraceAddedEvent) => {
          appended.push({ path, event });
          return { ...event, id: 'evt-1', deviceId: 'dev-1', timestamp: 1 };
        })
      },
      queryCache: {
        cachedQuery: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
        invalidateByType: jest.fn(),
        invalidateById: jest.fn(),
        invalidate: jest.fn()
      }
    } as unknown as RepositoryDependencies;
    return { repository: new TraceRepository(deps), appended, sqliteRuns };
  }

  it('writes a 5 MB content-write trace as a bounded record, identical in JSONL and SQLite', async () => {
    const { repository, appended, sqliteRuns } = makeRepository();
    await repository.addTrace('ws-1', 'session-1', {
      timestamp: 10,
      type: 'tool_call',
      content: 'Used tool',
      metadata: useToolsMetadata(splicedWriteCommand(5 * 1024 * 1024))
    });

    const jsonlMetadata = appended[0].event.data.metadataJson as string;
    const insert = sqliteRuns.find(run => run.sql.includes('INSERT INTO memory_traces'));
    expect(insert?.params[6]).toBe(jsonlMetadata);
    expect(utf8ByteLength(jsonlMetadata)).toBeLessThan(MAX_TRACE_METADATA_BYTES);

    const metadata = JSON.parse(jsonlMetadata) as {
      input: { arguments: { tool: string } };
      compaction: { originalBytes: number; omitted: Array<{ path: string }> };
    };
    expect(metadata.input.arguments.tool).toMatch(/^content write --path "QA Evidence\/native_after\.json" --content "<omitted 5\.0 MB sha256:[0-9a-f]{12}>"$/);
    expect(metadata.compaction.originalBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(metadata.compaction.omitted.map(entry => entry.path)).toEqual(['input.arguments.tool#0:--content']);
  });

  it('stores an ordinary trace exactly as before', async () => {
    const { repository, appended } = makeRepository();
    const metadata = useToolsMetadata('content read --path "Projects/A.md"');
    await repository.addTrace('ws-1', 'session-1', { type: 'tool_call', content: 'Used tool', metadata });
    expect(appended[0].event.data.metadataJson).toBe(JSON.stringify(metadata));
  });
});

describe('WorkspaceEventApplier trace replay', () => {
  function makeApplier() {
    const runs: Array<{ sql: string; params: unknown[] }> = [];
    const sqliteCache = { run: jest.fn(async (sql: string, params: unknown[]) => { runs.push({ sql, params }); }) };
    return { applier: new WorkspaceEventApplier(sqliteCache as never), runs };
  }

  function fatTraceEvent(metadataJson: string): TraceAddedEvent {
    return {
      id: 'evt-old-device',
      type: 'trace_added',
      deviceId: 'old-device',
      timestamp: 5,
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      data: { id: 'trace-1', content: 'Used tool', traceType: 'tool_call', metadataJson }
    } as TraceAddedEvent;
  }

  afterEach(() => {
    (Platform as { isMobile: boolean }).isMobile = false;
  });

  it('caches a bloated event from an older device in bounded form', async () => {
    const { applier, runs } = makeApplier();
    const original = JSON.stringify(useToolsMetadata(splicedWriteCommand(3 * 1024 * 1024)));
    const event = fatTraceEvent(original);

    await applier.apply(event);

    const cached = runs[0].params[6] as string;
    expect(utf8ByteLength(cached)).toBeLessThan(MAX_TRACE_METADATA_BYTES);
    expect(JSON.parse(cached).input.arguments.tool).toMatch(/^content write --path "QA Evidence\/native_after\.json" --content "<omitted /);
    // The applier never rewrites the event itself.
    expect(event.data.metadataJson).toBe(original);
  });

  it('gives every device the same cache row for the same event', async () => {
    const original = JSON.stringify(useToolsMetadata(splicedWriteCommand(200_000)));
    const first = makeApplier();
    const second = makeApplier();
    await first.applier.apply(fatTraceEvent(original));
    await second.applier.apply(fatTraceEvent(original));
    expect(first.runs[0].params[6]).toBe(second.runs[0].params[6]);
  });

  it('does not parse a record over the mobile ceiling on a phone', async () => {
    (Platform as { isMobile: boolean }).isMobile = true;
    const { applier, runs } = makeApplier();
    const original = JSON.stringify(useToolsMetadata(splicedWriteCommand(17 * 1024 * 1024)));
    const parse = jest.spyOn(JSON, 'parse');

    await applier.apply(fatTraceEvent(original));

    expect(parse).not.toHaveBeenCalledWith(original);
    parse.mockRestore();
    const cached = JSON.parse(runs[0].params[6] as string) as { compaction: { originalBytes: number } };
    expect(cached.compaction.originalBytes).toBe(utf8ByteLength(original));
  });
});

describe('WorkspaceMigrator legacy trace import', () => {
  it('imports a legacy trace carrying a whole loadWorkspace result in bounded form', async () => {
    const nestedDump: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      nestedDump[`s-${index}`] = { memoryTraces: { [`t-${index}`]: { content: 'earlier trace '.repeat(30) } } };
    }
    const legacyWorkspace = {
      id: 'ws-legacy',
      name: 'Legacy',
      sessions: {
        's-1': {
          name: 'Old session',
          memoryTraces: {
            'trace-legacy': {
              content: 'Successfully executed memoryManager.loadWorkspace',
              type: 'tool_call',
              metadata: { tool: 'memoryManager.loadWorkspace', params: { id: 'ws-legacy' }, result: { data: { workspace: { sessions: nestedDump } } } }
            }
          }
        }
      }
    };
    const appendEvents = jest.fn().mockResolvedValue(undefined);
    const migrator = new WorkspaceMigrator(
      { vault: { adapter: { read: jest.fn().mockResolvedValue(JSON.stringify(legacyWorkspace)) } } } as never,
      { appendEvents } as never,
      {} as never,
      {} as never
    );

    await (migrator as unknown as { migrateFile: (path: string, result: unknown) => Promise<void> })
      .migrateFile('legacy/ws-legacy.json', { workspaces: 0, sessions: 0, states: 0, traces: 0, errors: [] });

    const events = appendEvents.mock.calls[0][1] as TraceAddedEvent[];
    const trace = events.find(event => event.type === 'trace_added');
    expect(trace).toBeDefined();
    const metadataJson = trace?.data.metadataJson as string;
    expect(utf8ByteLength(metadataJson)).toBeLessThan(MAX_TRACE_METADATA_BYTES);
    expect(JSON.parse(metadataJson).result).toMatch(/^<omitted /);
  });
});
