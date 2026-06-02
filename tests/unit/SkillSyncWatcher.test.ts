/**
 * Tests for SkillSyncWatcher — verifies debounced, event-driven auto-sync:
 * path filtering (mirror + hidden source, `_archive/` excluded), coalescing,
 * the undocumented `raw` event leg, and clean teardown.
 */

jest.mock('../../src/agents/apps/skills/services/SkillSyncService', () => ({
  SkillSyncService: jest.fn().mockImplementation(() => ({
    import: jest.fn().mockResolvedValue({ imported: [], skipped: [], archived: [] }),
  })),
}));

import { SkillSyncWatcher } from '../../src/agents/apps/skills/services/SkillSyncWatcher';
import { SkillSyncService } from '../../src/agents/apps/skills/services/SkillSyncService';
import type { SkillsRuntime } from '../../src/agents/apps/skills/services/SkillsContext';

const MockedSyncService = SkillSyncService as unknown as jest.Mock;

type VaultEvent = 'create' | 'modify' | 'delete' | 'rename' | 'raw';
type EventHandler = (...args: unknown[]) => void;

function createMockApp() {
  const handlers = new Map<VaultEvent, Set<EventHandler>>([
    ['create', new Set()],
    ['modify', new Set()],
    ['delete', new Set()],
    ['rename', new Set()],
    ['raw', new Set()],
  ]);

  const offref = jest.fn((ref: unknown) => {
    const r = ref as { _event: VaultEvent; _fn: EventHandler };
    handlers.get(r._event)?.delete(r._fn);
  });

  const on = jest.fn((event: VaultEvent, fn: EventHandler) => {
    handlers.get(event)?.add(fn);
    return { _event: event, _fn: fn };
  });

  const fire = (event: VaultEvent, ...args: unknown[]) => {
    for (const fn of handlers.get(event) ?? []) {
      fn(...args);
    }
  };

  return { app: { vault: { on, offref } } as never, fire, handlers };
}

function makeRuntime(): SkillsRuntime {
  return {
    skillsRoot: 'Nexus/skills',
    vaultAdapter: {} as never,
    index: { syncFromScan: jest.fn().mockResolvedValue(undefined) } as never,
    scanner: { scan: jest.fn().mockResolvedValue([]) } as never,
    sqlite: {} as never,
  };
}

describe('SkillSyncWatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockedSyncService.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('debounces and coalesces a burst of mirror events into one sync', async () => {
    const { app, fire } = createMockApp();
    const rt = makeRuntime();
    const watcher = new SkillSyncWatcher(app, () => rt, 2000);
    watcher.start();

    // The initial catch-up sync schedules immediately on start(); flush it.
    await jest.advanceTimersByTimeAsync(2000);
    expect(MockedSyncService).toHaveBeenCalledTimes(1);
    MockedSyncService.mockClear();

    // Burst of edits inside one window → a single sync.
    fire('modify', { path: 'Nexus/skills/claude/test/SKILL.md' });
    fire('modify', { path: 'Nexus/skills/claude/test/reference.md' });
    fire('create', { path: 'Nexus/skills/claude/test/scripts/run.sh' });
    await jest.advanceTimersByTimeAsync(2000);

    expect(MockedSyncService).toHaveBeenCalledTimes(1);
    expect(rt.scanner.scan).toHaveBeenCalled();
    expect(rt.index.syncFromScan).toHaveBeenCalled();
  });

  it('ignores non-skill paths and `_archive/` churn', async () => {
    const { app, fire } = createMockApp();
    const rt = makeRuntime();
    const watcher = new SkillSyncWatcher(app, () => rt, 2000);
    watcher.start();
    await jest.advanceTimersByTimeAsync(2000); // drain initial sync
    MockedSyncService.mockClear();

    fire('modify', { path: 'notes/journal.md' });
    fire('create', { path: 'Nexus/other/file.md' });
    fire('modify', { path: 'Nexus/skills/claude/test/_archive/20260531/SKILL.md' });
    await jest.advanceTimersByTimeAsync(2000);

    expect(MockedSyncService).not.toHaveBeenCalled();
  });

  it('reacts to hidden provider dotfolders via the `raw` event', async () => {
    const { app, fire } = createMockApp();
    const rt = makeRuntime();
    const watcher = new SkillSyncWatcher(app, () => rt, 2000);
    watcher.start();
    await jest.advanceTimersByTimeAsync(2000); // drain initial sync
    MockedSyncService.mockClear();

    fire('raw', '.claude/skills/test-skill/SKILL.md');
    await jest.advanceTimersByTimeAsync(2000);

    expect(MockedSyncService).toHaveBeenCalledTimes(1);
  });

  it('retries the initial sync while the runtime is not yet ready', async () => {
    const { app } = createMockApp();
    let ready = false;
    const rt = makeRuntime();
    const watcher = new SkillSyncWatcher(app, () => (ready ? rt : null), 2000);
    watcher.start();

    await jest.advanceTimersByTimeAsync(2000); // runtime null → no sync, reschedules
    expect(MockedSyncService).not.toHaveBeenCalled();

    ready = true;
    await jest.advanceTimersByTimeAsync(2000); // retry now succeeds
    expect(MockedSyncService).toHaveBeenCalledTimes(1);
  });

  it('stop() unsubscribes every handler and cancels pending work', async () => {
    const { app, fire } = createMockApp();
    const offref = (app as unknown as { vault: { offref: jest.Mock } }).vault.offref;
    const rt = makeRuntime();
    const watcher = new SkillSyncWatcher(app, () => rt, 2000);
    watcher.start();
    await jest.advanceTimersByTimeAsync(2000); // drain initial sync
    MockedSyncService.mockClear();

    fire('modify', { path: 'Nexus/skills/claude/test/SKILL.md' });
    watcher.stop();
    await jest.advanceTimersByTimeAsync(5000);

    expect(offref).toHaveBeenCalled();          // create+modify+delete+rename+raw
    expect(MockedSyncService).not.toHaveBeenCalled(); // pending run was cancelled
  });
});
