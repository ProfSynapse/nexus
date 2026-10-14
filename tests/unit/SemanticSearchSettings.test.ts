/**
 * The Semantic search fold on Defaults, inside the real DefaultsTab and renderer.
 *
 * Failures this buys: the fold used to be a bare switch that saved the setting
 * and asked for a restart. It now shows the index status from the embedding
 * runtime, shows progress with pause/resume while indexing, asks before turning
 * search off, applies the switch at runtime, and offers Delete index (behind its
 * own confirmation) only while search is off.
 *
 * Mocked: model lists (fixtures), the two confirmation modals (their answers are
 * the input under test; the modals themselves have their own tests), and the
 * embedding runtime (a fake with EmbeddingManager's public shape). Real:
 * DefaultsTab, its save queue, the renderer, the accordion and the fold.
 */
jest.mock('../../src/services/llm/providers/ProviderManager', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
jest.mock('../../src/services/StaticModelsService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').staticModelsModule());
jest.mock('../../src/services/llm/ImageGenerationService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').imageServiceModule());
jest.mock('../../src/agents/ingestManager/tools/services/IngestCapabilityService', () =>
  jest.requireActual('../helpers/settingsRendererFixtures').ingestCapabilityModule());
jest.mock('../../src/settings/tabs/defaults/SemanticSearchOffModal', () => ({
  SemanticSearchOffModal: { confirm: jest.fn() }
}));
jest.mock('../../src/settings/components/ConfirmModal', () => ({
  ConfirmModal: { confirm: jest.fn() }
}));

import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { SemanticSearchOffModal } from '../../src/settings/tabs/defaults/SemanticSearchOffModal';
import { ConfirmModal } from '../../src/settings/components/ConfirmModal';
import {
  FOLD_TITLES,
  SEMANTIC_COPY as COPY,
  SEMANTIC_DELETE_MODAL_COPY
} from '../../src/components/shared/chatSettings/copy';
import { resolveSemanticSearchRuntime } from '../../src/settings/tabs/defaults/SemanticSearchSettings';
import type { EmbeddingRuntimeStatus, EmbeddingStats } from '../../src/services/embeddings/EmbeddingManager';
import type { IndexingProgress } from '../../src/services/embeddings/IndexingQueue';
import { llmSettings } from '../helpers/settingsRendererFixtures';
import { control, findRow, flush, foldItems, foldSummary, localStorageApp, rowDesc, rowNames } from '../helpers/settingsDom';

const confirmTurnOff = SemanticSearchOffModal.confirm as jest.Mock;
const confirmDelete = ConfirmModal.confirm as jest.Mock;

/** A stand-in for EmbeddingManager with the same public surface the fold uses. */
class FakeRuntime {
  enabled: boolean;
  status: EmbeddingRuntimeStatus;
  stats = { noteCount: 4512, traceCount: 40, conversationChunkCount: 900, conversationCount: 318 };
  listeners = new Set<(status: EmbeddingRuntimeStatus) => void>();
  pauseIndexing = jest.fn(() => { this.status = { ...this.status, paused: true }; this.emit(); });
  resumeIndexing = jest.fn(() => { this.status = { ...this.status, paused: false }; this.emit(); });
  deleteIndex = jest.fn(async () => {
    if (this.enabled) throw new Error('Turn semantic search off before deleting its index.');
    this.stats = { noteCount: 0, traceCount: 0, conversationChunkCount: 0, conversationCount: 0 };
    this.emit();
  });
  setEnabled = jest.fn(async (enabled: boolean) => {
    this.enabled = enabled;
    this.status = { enabled, initialized: enabled, indexing: false, paused: false, progress: null };
    this.emit();
  });

  constructor(enabled = true) {
    this.enabled = enabled;
    this.status = { enabled, initialized: enabled, indexing: false, paused: false, progress: null };
  }

  getStatus(): EmbeddingRuntimeStatus {
    return this.status;
  }

  async getStats(): Promise<EmbeddingStats> {
    return {
      enabled: this.enabled,
      initialized: this.enabled,
      ...this.stats,
      indexingInProgress: this.status.indexing,
      indexingPaused: this.status.paused
    };
  }

  onStateChange(listener: (status: EmbeddingRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener(this.status);
  }

  /** Report an indexing pass, as the queue's progress events do. */
  indexing(progress: Partial<IndexingProgress> = {}, paused = false): void {
    this.status = {
      ...this.status,
      indexing: true,
      paused,
      progress: {
        phase: paused ? 'paused' : 'indexing',
        totalNotes: 4512,
        processedNotes: 1904,
        currentNote: 'Notes/a.md',
        estimatedTimeRemaining: 240,
        ...progress
      }
    };
    this.emit();
  }

  finishIndexing(): void {
    this.status = { ...this.status, indexing: false, paused: false, progress: { ...this.status.progress!, phase: 'complete' } };
    this.emit();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

async function render(options: { enabled?: boolean; runtime?: FakeRuntime | null } = {}) {
  const enabled = options.enabled ?? true;
  const runtime = options.runtime === undefined ? new FakeRuntime(enabled) : options.runtime;
  const container = createFakeRoot();
  const saveSettings = jest.fn(async () => undefined);
  const pluginSettings = { enableEmbeddings: enabled } as Record<string, unknown>;
  const applyEnabled = jest.fn(async (value: boolean) => { await runtime?.setEnabled(value); });
  const tab = new DefaultsTab(container as unknown as HTMLElement, {
    app: localStorageApp() as never,
    settings: { settings: pluginSettings, saveSettings } as never,
    llmProviderSettings: llmSettings(),
    semanticSearch: {
      getRuntime: () => runtime as never,
      applyEnabled
    }
  });
  await settle();
  const root = container.children[0];
  const items = () => foldItems(root, FOLD_TITLES.semanticSearch);
  const summary = () => foldSummary(root, FOLD_TITLES.semanticSearch);
  return { tab, root, items, summary, runtime: runtime as FakeRuntime, pluginSettings, saveSettings, applyEnabled };
}

function value(row: FakeElement): string {
  return row.querySelector('.nexus-semantic-value')?.textContent ?? '';
}

function toggleOf(items: FakeElement): FakeElement {
  return control(findRow(items, COPY.toggle), '.checkbox-container');
}

beforeEach(() => {
  confirmTurnOff.mockReset();
  confirmDelete.mockReset();
});

describe('Semantic search fold', () => {
  it('shows the index counts while on and indexed', async () => {
    const { tab, items, summary } = await render();
    try {
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index]);
      expect(rowDesc(findRow(items(), COPY.toggle))).toBe(COPY.toggleDesc);
      expect(rowDesc(findRow(items(), COPY.index))).toBe(COPY.indexOnDesc);
      expect(value(findRow(items(), COPY.index))).toBe('4,512 notes · 318 chats');
      expect(toggleOf(items()).hasClass('is-enabled')).toBe(true);
      expect(summary()).toBe('On · 4,512 notes');
    } finally {
      tab.destroy();
    }
  });

  it('shows progress, an estimate and pause while indexing, and updates in place', async () => {
    const { tab, items, summary, runtime } = await render();
    try {
      runtime.indexing();
      await settle();
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.indexing]);
      const row = findRow(items(), COPY.indexing);
      expect(rowDesc(row)).toBe('About 4 minutes left. You can keep working.');
      expect(value(row)).toBe('1,904 / 4,512');
      expect(Number(row.querySelector('.setting-progress-bar')?.getAttribute('data-value'))).toBeCloseTo(42.2, 1);
      const pause = control(row, '.extra-setting-button');
      expect(pause.getAttribute('aria-label')).toBe(COPY.pauseIndexing);
      expect(summary()).toBe('Indexing · 42%');

      // A progress event updates the same row rather than rebuilding the fold.
      runtime.indexing({ processedNotes: 2256, estimatedTimeRemaining: 30 });
      expect(findRow(items(), COPY.indexing)).toBe(row);
      expect(value(row)).toBe('2,256 / 4,512');
      expect(rowDesc(row)).toBe('Less than a minute left. You can keep working.');
      expect(summary()).toBe('Indexing · 50%');

      pause.click();
      expect(runtime.pauseIndexing).toHaveBeenCalledTimes(1);
      const resume = control(findRow(items(), COPY.indexing), '.extra-setting-button');
      expect(resume.getAttribute('aria-label')).toBe(COPY.resumeIndexing);
      expect(resume.getAttribute('data-icon')).toBe('play');
      resume.click();
      expect(runtime.resumeIndexing).toHaveBeenCalledTimes(1);

      runtime.finishIndexing();
      await settle();
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index]);
      expect(summary()).toBe('On · 4,512 notes');
    } finally {
      tab.destroy();
    }
  });

  it('keeps search on when the turn-off confirmation is cancelled', async () => {
    const { tab, items, pluginSettings, saveSettings, applyEnabled, runtime } = await render();
    try {
      confirmTurnOff.mockResolvedValue(false);
      toggleOf(items()).click();
      await settle();
      expect(confirmTurnOff).toHaveBeenCalledTimes(1);
      expect(pluginSettings.enableEmbeddings).toBe(true);
      expect(saveSettings).not.toHaveBeenCalled();
      expect(applyEnabled).not.toHaveBeenCalled();
      expect(runtime.setEnabled).not.toHaveBeenCalled();
      expect(toggleOf(items()).hasClass('is-enabled')).toBe(true);
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index]);
    } finally {
      tab.destroy();
    }
  });

  it('turns search off at runtime after confirmation, keeping the index', async () => {
    const { tab, items, summary, pluginSettings, saveSettings, applyEnabled, runtime } = await render();
    try {
      confirmTurnOff.mockResolvedValue(true);
      toggleOf(items()).click();
      await settle();
      expect(pluginSettings.enableEmbeddings).toBe(false);
      expect(saveSettings).toHaveBeenCalledTimes(1);
      expect(applyEnabled).toHaveBeenCalledWith(false);
      expect(runtime.enabled).toBe(false);
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index, COPY.deleteIndex]);
      expect(rowDesc(findRow(items(), COPY.index))).toBe(COPY.indexOffDesc);
      expect(value(findRow(items(), COPY.index))).toBe('Paused · 4,512 notes');
      expect(toggleOf(items()).hasClass('is-enabled')).toBe(false);
      expect(summary()).toBe('Off · index kept');
      expect(items().textContent).not.toContain('Restart');
    } finally {
      tab.destroy();
    }
  });

  it('turns search back on without asking', async () => {
    const { tab, items, summary, pluginSettings, applyEnabled } = await render({ enabled: false });
    try {
      toggleOf(items()).click();
      await settle();
      expect(confirmTurnOff).not.toHaveBeenCalled();
      expect(pluginSettings.enableEmbeddings).toBe(true);
      expect(applyEnabled).toHaveBeenCalledWith(true);
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index]);
      expect(summary()).toBe('On · 4,512 notes');
    } finally {
      tab.destroy();
    }
  });

  it('deletes the index only after its own confirmation', async () => {
    const { tab, items, summary, runtime } = await render({ enabled: false });
    try {
      const row = findRow(items(), COPY.deleteIndex);
      expect(rowDesc(row)).toBe(COPY.deleteIndexDesc);
      const button = control(row, 'button');
      expect(button.textContent).toBe(COPY.deleteIndex);
      expect(button.hasClass('mod-warning')).toBe(true);

      confirmDelete.mockResolvedValue(false);
      button.click();
      await settle();
      expect(confirmDelete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        variant: 'delete',
        title: SEMANTIC_DELETE_MODAL_COPY.title,
        cancelLabel: 'Cancel',
        ctaLabel: 'Delete'
      }));
      expect(runtime.deleteIndex).not.toHaveBeenCalled();
      expect(value(findRow(items(), COPY.index))).toBe('Paused · 4,512 notes');

      confirmDelete.mockResolvedValue(true);
      control(findRow(items(), COPY.deleteIndex), 'button').click();
      await settle();
      expect(runtime.deleteIndex).toHaveBeenCalledTimes(1);
      expect(value(findRow(items(), COPY.index))).toBe(COPY.noIndex);
      expect(control(findRow(items(), COPY.deleteIndex), 'button').disabled).toBe(true);
      expect(summary()).toBe('Off · no index');
    } finally {
      tab.destroy();
    }
  });

  it('follows a change applied elsewhere (another device) while mounted', async () => {
    const { tab, items, pluginSettings, runtime } = await render();
    try {
      pluginSettings.enableEmbeddings = false;
      await runtime.setEnabled(false);
      await settle();
      expect(rowNames(items())).toEqual([COPY.toggle, COPY.index, COPY.deleteIndex]);
    } finally {
      tab.destroy();
    }
  });

  it('stops listening to the runtime when destroyed', async () => {
    const { tab, runtime } = await render();
    expect(runtime.listeners.size).toBe(1);
    tab.destroy();
    expect(runtime.listeners.size).toBe(0);
  });

  it('shows the switch state and saves the setting without a runtime', async () => {
    const { tab, items, summary } = await render({ enabled: false, runtime: null });
    try {
      expect(value(findRow(items(), COPY.index))).toBe(COPY.indexPausedUnknown);
      expect(control(findRow(items(), COPY.deleteIndex), 'button').disabled).toBe(true);
      expect(summary()).toBe('Off · index kept');
    } finally {
      tab.destroy();
    }
  });
});

describe('resolveSemanticSearchRuntime', () => {
  it('returns the plugin embedding manager only when it has the runtime surface', () => {
    const runtime = new FakeRuntime();
    expect(resolveSemanticSearchRuntime({ embeddingManager: runtime })).toBe(runtime);
    expect(resolveSemanticSearchRuntime({ embeddingManager: { getStatus: () => null } })).toBeNull();
    expect(resolveSemanticSearchRuntime({})).toBeNull();
    expect(resolveSemanticSearchRuntime(null)).toBeNull();
  });
});
