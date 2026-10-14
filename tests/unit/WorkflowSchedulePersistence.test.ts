/**
 * The workflow scheduler ticks every minute on every device. Its watermark must
 * live in device-local storage: writing it to data.json made Obsidian Sync
 * upload the file continuously and every other device reload it. A tick also
 * must never re-upload this device's stale settings.
 */
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
  const local = new Map<string, unknown>();
  const app = {
    loadLocalStorage: jest.fn((key: string) => (local.has(key) ? JSON.parse(JSON.stringify(local.get(key))) as unknown : null)),
    saveLocalStorage: jest.fn((key: string, value: unknown) => { local.set(key, JSON.parse(JSON.stringify(value))); }),
  };
  const plugin = { app, loadData, saveData, register: (callback: () => void) => { unload.push(callback); }, registerInterval } as unknown as Plugin;
  const settings = new Settings(plugin);
  const getAllWorkspaces = jest.fn(async () => []);
  const scheduler = new WorkflowScheduleService({
    plugin, settings, workspaceService: { getAllWorkspaces }, conversationService: {}, workflowRunService: {},
  } as unknown as WorkflowScheduleServiceDeps);
  return { settings, scheduler, getAllWorkspaces, loadData, saveData, registerInterval, unload, app,
    localWatermark: () => (local.get('nexus-workflow-scheduler') as { lastCheckAt?: number } | undefined)?.lastCheckAt,
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

  it('never writes data.json on a tick, so synced settings are neither uploaded nor overwritten', async () => {
    const h = fixture();
    await h.settings.loadSettings();
    await h.scheduler.start();
    h.syncNewSettings();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(h.saveData).not.toHaveBeenCalled();
    expect(h.disk.llmProviders.providers.anthropic.apiKey).toBe('new-key');
    expect(h.disk.enableEmbeddings).toBe(false);
    expect(h.disk.workflowScheduler.lastCheckAt).toBe(100);
    expect(h.localWatermark()).toBe(240_000);
    await h.scheduler.cleanup();
  });

  it('honours a watermark older versions saved in data.json as a floor, and never moves backwards', async () => {
    const h = fixture();
    h.disk.workflowScheduler.lastCheckAt = 500_000;
    await h.settings.loadSettings();
    expect(h.settings.getWorkflowSchedulerWatermark()).toBe(500_000);
    await h.settings.saveWorkflowSchedulerState(120_000);
    expect(h.settings.getWorkflowSchedulerWatermark()).toBe(500_000);
    await h.settings.saveWorkflowSchedulerState(600_000);
    expect(h.localWatermark()).toBe(600_000);
    expect(h.settings.getWorkflowSchedulerWatermark()).toBe(600_000);
    await h.settings.saveWorkflowSchedulerState(550_000);
    expect(h.localWatermark()).toBe(600_000);
    expect(h.saveData).not.toHaveBeenCalled();
  });

  it('keeps advancing the watermark without enabled schedules so later enablement cannot backfill an idle gap', async () => {
    const h = fixture();
    await h.settings.loadSettings();
    await h.scheduler.start();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(h.localWatermark()).toBe(240_000);
    expect(h.settings.getWorkflowSchedulerWatermark()).toBe(240_000);
    await h.scheduler.cleanup();
  });

  it('does not rewrite local storage when the watermark has not moved', async () => {
    const h = fixture();
    await h.settings.saveWorkflowSchedulerState(100);
    await h.settings.saveWorkflowSchedulerState(100);
    expect(h.app.saveLocalStorage).toHaveBeenCalledTimes(1);
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
    expect(h.app.saveLocalStorage).not.toHaveBeenCalled();
    expect(h.registerInterval).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
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
