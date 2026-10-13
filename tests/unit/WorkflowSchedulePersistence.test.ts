/** A scheduler tick must not re-upload this device's stale API keys after Obsidian Sync updates data.json. */
import type { Plugin } from 'obsidian';
import { Settings } from '../../src/settings';
import { WorkflowScheduleService, type WorkflowScheduleServiceDeps } from '../../src/services/workflows/WorkflowScheduleService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let disk = {
    llmProviders: { providers: { anthropic: { enabled: true, apiKey: 'old-key' } }, defaultModel: { provider: 'anthropic', model: 'old-model' } },
    workflowScheduler: { lastCheckAt: 100 },
    pluginStorage: { retained: true },
    enableEmbeddings: true,
  };
  const unload: Array<() => void> = [];
  const loadData = jest.fn(async () => JSON.parse(JSON.stringify(disk)) as unknown);
  const saveData = jest.fn(async (data: typeof disk) => { disk = JSON.parse(JSON.stringify(data)) as typeof disk; });
  const registerInterval = jest.fn();
  const plugin = { loadData, saveData, register: (callback: () => void) => { unload.push(callback); }, registerInterval } as unknown as Plugin;
  const settings = new Settings(plugin);
  const getAllWorkspaces = jest.fn(async () => []);
  const scheduler = new WorkflowScheduleService({
    plugin, settings, workspaceService: { getAllWorkspaces }, conversationService: {}, workflowRunService: {},
  } as unknown as WorkflowScheduleServiceDeps);
  return { settings, scheduler, getAllWorkspaces, loadData, saveData, registerInterval, unload,
    get disk() { return disk; },
    syncNewSettings() {
      disk.llmProviders.providers.anthropic.apiKey = 'new-key';
      disk.llmProviders.defaultModel.model = 'new-model';
      disk.enableEmbeddings = false;
    },
  };
}

describe('Workflow scheduler settings persistence', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(60_000); });
  afterEach(() => jest.useRealTimers());

  it('preserves synced credentials and unrelated settings through real Settings on the next minute tick', async () => {
    const h = fixture();
    await h.settings.loadSettings();
    await h.scheduler.start();
    h.settings.settings.llmProviders.providers.anthropic.userDescription = 'Unsaved local edit';
    h.syncNewSettings();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.settings.settings.llmProviders.providers.anthropic.apiKey).toBe('new-key');
    expect(h.settings.settings.llmProviders.providers.anthropic.userDescription).toBe('Unsaved local edit');
    expect(h.disk.llmProviders.providers.anthropic).not.toHaveProperty('userDescription');
    expect(h.disk.llmProviders.providers.anthropic.apiKey).toBe('new-key');
    expect(h.disk.llmProviders.defaultModel.model).toBe('new-model');
    expect(h.disk.enableEmbeddings).toBe(false);
    expect(h.disk.pluginStorage).toEqual({ retained: true });
    expect(h.disk.workflowScheduler.lastCheckAt).toBe(120_000);
    await h.settings.saveSettings();
    expect(h.disk.llmProviders.providers.anthropic).toMatchObject({ apiKey: 'new-key', userDescription: 'Unsaved local edit' });
    await h.scheduler.cleanup();
  });

  it('does not rewrite an unchanged or newer persisted watermark', async () => {
    const h = fixture();
    await h.settings.saveWorkflowSchedulerState(100);
    await h.settings.saveWorkflowSchedulerState(50);
    expect(h.saveData).not.toHaveBeenCalled();
    expect(h.settings.settings.workflowScheduler?.lastCheckAt).toBe(100);
  });

  it('keeps advancing the watermark without enabled schedules so later enablement cannot backfill an idle gap', async () => {
    const h = fixture();
    await h.settings.loadSettings();
    await h.scheduler.start();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(h.disk.workflowScheduler.lastCheckAt).toBe(240_000);
    await h.scheduler.cleanup();
  });

  it('does not persist or register a late timer when unload interrupts startup', async () => {
    const h = fixture();
    const pending = deferred<never[]>();
    h.getAllWorkspaces.mockReturnValueOnce(pending.promise);
    const start = h.scheduler.start();
    h.unload.forEach(callback => callback());
    pending.resolve([]);
    await start;
    await h.scheduler.cleanup();
    expect(h.saveData).not.toHaveBeenCalled();
    expect(h.registerInterval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels an in-flight settings read before it can write after unload', async () => {
    const h = fixture();
    const read = deferred<unknown>();
    h.loadData.mockReturnValueOnce(read.promise);
    const scan = h.scheduler.scanDueWorkflows(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.loadData).toHaveBeenCalledTimes(1);
    h.unload.forEach(callback => callback());
    read.resolve(h.disk);
    await scan;
    await h.scheduler.cleanup();
    expect(h.saveData).not.toHaveBeenCalled();
  });

  it('clears the running interval and prevents scans after cleanup', async () => {
    const h = fixture();
    await h.scheduler.start();
    await h.scheduler.cleanup();
    await h.scheduler.start();
    await h.scheduler.scanDueWorkflows(false);
    await jest.advanceTimersByTimeAsync(180_000);
    expect(h.getAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
