/** Fails if turning off source import also turns off native indexing or cleanup leaks callbacks. */
import { SkillSyncWatcher } from '../../src/services/skills/SkillSyncWatcher';
import type { App } from 'obsidian';
import type { CoreSkillsSettings, ServiceResult } from '../../src/services/instructions/types';

function setup(automaticImport = false) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const vault = {
    on: jest.fn((event: string, fn: (...args: unknown[]) => void) => {
      const set = handlers.get(event) ?? new Set(); set.add(fn); handlers.set(event, set);
      return { event, fn };
    }),
    offref: jest.fn((ref: { event: string; fn: (...args: unknown[]) => void }) => handlers.get(ref.event)?.delete(ref.fn)),
  };
  const prefs: CoreSkillsSettings = { version: 1, automaticImport, syncBackOnEdit: false };
  const service = {
    getRoot: () => 'Custom/skills', getPreferences: () => prefs,
    refreshIndex: jest.fn<Promise<ServiceResult<void>>, [{ importProviders?: boolean }?]>().mockResolvedValue({ ok: true, value: undefined }),
  };
  const watcher = new SkillSyncWatcher({ vault } as unknown as App, service, 20);
  const fire = (event: string, ...args: unknown[]) => handlers.get(event)?.forEach(fn => fn(...args));
  return { watcher, service, fire, handlers, vault, prefs };
}

describe('Core SkillSyncWatcher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });
  it('indexes native files while automatic provider import is off', async () => {
    const { watcher, service, fire } = setup(); watcher.start();
    await jest.advanceTimersByTimeAsync(20);
    expect(service.refreshIndex).toHaveBeenCalledWith({ importProviders: false });
    service.refreshIndex.mockClear();
    fire('modify', { path: 'Custom/skills/nexus/write/SKILL.md' });
    fire('modify', { path: 'Custom/skills/nexus/write/examples/one.md' });
    await jest.advanceTimersByTimeAsync(20);
    expect(service.refreshIndex).toHaveBeenCalledTimes(1);
  });
  it('ignores hidden provider changes unless automatic import is enabled', async () => {
    const { watcher, service, fire, prefs } = setup(); watcher.start();
    await jest.advanceTimersByTimeAsync(20); service.refreshIndex.mockClear();
    fire('raw', '.claude/skills/write/SKILL.md');
    await jest.advanceTimersByTimeAsync(20); expect(service.refreshIndex).not.toHaveBeenCalled();
    prefs.automaticImport = true;
    fire('raw', '.claude/skills/write/SKILL.md');
    await jest.advanceTimersByTimeAsync(20);
    expect(service.refreshIndex).toHaveBeenCalledWith({ importProviders: true });
  });
  it('does not react to archive history or unrelated files', async () => {
    const { watcher, service, fire } = setup(true); watcher.start();
    await jest.advanceTimersByTimeAsync(20); service.refreshIndex.mockClear();
    fire('modify', { path: 'Custom/skills/nexus/write/_archive/one/SKILL.md' });
    fire('modify', { path: 'notes/one.md' });
    await jest.advanceTimersByTimeAsync(20); expect(service.refreshIndex).not.toHaveBeenCalled();
  });
  it('registers once and removes subscriptions and pending work on stop', async () => {
    const { watcher, service, handlers } = setup(); watcher.start(); watcher.start(); watcher.stop();
    await jest.advanceTimersByTimeAsync(100);
    expect(service.refreshIndex).not.toHaveBeenCalled();
    expect([...handlers.values()].every(set => set.size === 0)).toBe(true);
  });
  it('retries initializing storage within a bounded catch-up window', async () => {
    const { watcher, service } = setup();
    service.refreshIndex.mockResolvedValue({ ok: false, error: { code: 'initializing', message: 'cold' } });
    watcher.start(); await jest.advanceTimersByTimeAsync(500);
    expect(service.refreshIndex).toHaveBeenCalledTimes(6);
  });
  it('coalesces overlap without running another operation after stop', async () => {
    const { watcher, service, fire } = setup();
    let complete!: (result: ServiceResult<void>) => void;
    service.refreshIndex.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    watcher.start(); await jest.advanceTimersByTimeAsync(20);
    fire('modify', { path: 'Custom/skills/nexus/write/SKILL.md' });
    await jest.advanceTimersByTimeAsync(20); watcher.stop();
    complete({ ok: true, value: undefined }); await jest.advanceTimersByTimeAsync(100);
    expect(service.refreshIndex).toHaveBeenCalledTimes(1);
  });
});
