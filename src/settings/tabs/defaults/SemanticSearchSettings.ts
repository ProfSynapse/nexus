/**
 * The Semantic search fold on Defaults (desktop only).
 *
 * Rows:
 * - the `enableEmbeddings` switch, applied at runtime (no restart). Turning it
 *   off asks first (SemanticSearchOffModal); Cancel or Escape leaves it on.
 * - while on: "Index" with the stored note and chat counts, or, while a pass
 *   runs, "Indexing" with a progress bar, the done / total count, an estimate
 *   and a pause / resume button.
 * - while off: "Index" with what is being kept, and "Delete index", which asks
 *   for confirmation and then deletes the stored vectors only.
 *
 * Status comes from the embedding runtime (EmbeddingManager) through a narrow
 * interface, resolved on every use: the runtime is created only once storage is
 * ready, so it can appear after the fold was first drawn. Until it does, the
 * fold checks for it once a second and redraws when it arrives. The fold
 * subscribes to its state while mounted and unsubscribes on destroy.
 */

import { Notice, Setting, type ProgressBarComponent } from 'obsidian';
import { FOLD_ICONS, FOLD_IDS, FOLD_TITLES, SEMANTIC_COPY as COPY } from '../../../components/shared/chatSettings/copy';
import { semanticSearchSummary } from '../../../components/shared/chatSettings/sectionSummaries';
import type { FoldDefinition, FoldHost } from '../../../components/shared/chatSettings/types';
import type { EmbeddingManager } from '../../../services/embeddings/EmbeddingManager';
import type { IndexingProgress } from '../../../services/embeddings/IndexingQueue';

/** The parts of EmbeddingManager the fold uses. */
export type SemanticSearchRuntime = Pick<EmbeddingManager,
  'getStatus' | 'getStats' | 'onStateChange' | 'pauseIndexing' | 'resumeIndexing' | 'deleteIndex' | 'setEnabled'>;

const RUNTIME_METHODS: Array<keyof SemanticSearchRuntime> = [
  'getStatus', 'getStats', 'onStateChange', 'pauseIndexing', 'resumeIndexing', 'deleteIndex', 'setEnabled'
];

/**
 * The plugin's embedding runtime (`plugin.embeddingManager`), or null when it
 * does not exist yet (storage still loading) or on mobile.
 */
export function resolveSemanticSearchRuntime(plugin: unknown): SemanticSearchRuntime | null {
  if (plugin === null || typeof plugin !== 'object') return null;
  const manager = (plugin as { embeddingManager?: unknown }).embeddingManager;
  if (manager === null || typeof manager !== 'object') return null;
  const candidate = manager as Record<string, unknown>;
  return RUNTIME_METHODS.every(method => typeof candidate[method] === 'function')
    ? manager as SemanticSearchRuntime
    : null;
}

export interface SemanticSearchDeps {
  /** The saved `enableEmbeddings` switch (on when absent). */
  isEnabled(): boolean;
  /** Persist the switch (through the Defaults save queue). */
  setEnabled(enabled: boolean): void;
  /** Apply the switch to the running plugin, without a restart. */
  applyEnabled(enabled: boolean): Promise<void>;
  /** The live runtime, or null before it exists. Resolved on every use. */
  getRuntime(): SemanticSearchRuntime | null;
  /** Ask before turning search off. Resolves true to go ahead. */
  confirmTurnOff(): Promise<boolean>;
  /** Ask before deleting the index. Resolves true to go ahead. */
  confirmDeleteIndex(): Promise<boolean>;
}

type IndexCounts = { notes: number; chats: number; total: number };

type CountsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; counts: IndexCounts }
  | { status: 'failed' };

type FoldView =
  | { mode: 'off'; key: string }
  | { mode: 'on'; key: string }
  | { mode: 'indexing'; key: string; paused: boolean; progress: IndexingProgress };

/** Phases in which a pass is running and its progress is worth showing. */
const ACTIVE_PHASES = new Set<IndexingProgress['phase']>(['loading_model', 'indexing', 'paused']);

/** How often a fold drawn before the runtime existed checks for it. */
const RUNTIME_POLL_MS = 1000;

function percentOf(progress: IndexingProgress): number {
  if (progress.totalNotes <= 0) return 0;
  return Math.min(100, Math.max(0, (progress.processedNotes / progress.totalNotes) * 100));
}

export class SemanticSearchSettings implements FoldDefinition {
  readonly id = FOLD_IDS.semanticSearch;
  readonly title = FOLD_TITLES.semanticSearch;
  readonly icon = FOLD_ICONS.semanticSearch;

  private host: FoldHost | null = null;
  private counts: CountsState = { status: 'idle' };
  /** Bumped whenever the counts go stale, so a slower, older read is dropped. */
  private countsRequest = 0;
  private subscription: { runtime: SemanticSearchRuntime; unsubscribe: () => void } | null = null;
  /** The view drawn last; a state change to a different one redraws the rows. */
  private drawnKey = '';
  /** The live Indexing row, updated in place on each progress event. */
  private indexingRow: { setting: Setting; bar: ProgressBarComponent | null; valueEl: HTMLElement } | null = null;
  private deleting = false;
  private destroyed = false;
  /** Interval that watches for the runtime to appear; null when not waiting. */
  private runtimeWait: number | null = null;

  constructor(private readonly deps: SemanticSearchDeps) {}

  getSummary(): string {
    const view = this.view();
    if (view.mode === 'off') {
      const counts = this.readyCounts();
      return semanticSearchSummary({ enabled: false, indexKept: counts ? counts.total > 0 : undefined });
    }
    if (view.mode === 'indexing') {
      return semanticSearchSummary({ enabled: true, indexingPercent: percentOf(view.progress) });
    }
    return semanticSearchSummary({ enabled: true, noteCount: this.readyCounts()?.notes });
  }

  /** Draw the rows into `itemsEl` (a fold's `setting-items` list). */
  render(itemsEl: HTMLElement, host: FoldHost): void {
    this.host = host;
    this.indexingRow = null;
    this.subscribe();
    this.waitForRuntime();

    const view = this.view();
    this.drawnKey = view.key;

    new Setting(itemsEl)
      .setName(COPY.toggle)
      .setDesc(COPY.toggleDesc)
      .addToggle(toggle => toggle
        .setValue(view.mode !== 'off')
        .onChange(value => { void this.onToggle(value); }));

    if (view.mode === 'indexing') {
      this.renderIndexing(itemsEl, view.progress, view.paused);
    } else if (view.mode === 'on') {
      this.renderIndexOn(itemsEl);
    } else {
      this.renderIndexOff(itemsEl);
    }

    if (this.counts.status === 'idle') this.loadCounts();
    host.setSummary(this.getSummary());
  }

  destroy(): void {
    this.destroyed = true;
    this.stopWaitingForRuntime();
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.host = null;
    this.indexingRow = null;
  }

  private view(): FoldView {
    if (!this.deps.isEnabled()) return { mode: 'off', key: 'off' };
    const status = this.deps.getRuntime()?.getStatus();
    const progress = status?.progress;
    if (status?.indexing && progress && ACTIVE_PHASES.has(progress.phase)) {
      const paused = status.paused || progress.phase === 'paused';
      return { mode: 'indexing', key: paused ? 'indexing-paused' : 'indexing', paused, progress };
    }
    return { mode: 'on', key: 'on' };
  }

  private readyCounts(): IndexCounts | null {
    return this.counts.status === 'ready' ? this.counts.counts : null;
  }

  private renderIndexOn(itemsEl: HTMLElement): void {
    const counts = this.readyCounts();
    const value = counts
      ? COPY.indexCounts(counts.notes, counts.chats)
      : this.deps.getRuntime() ? '' : COPY.starting;
    const setting = new Setting(itemsEl).setName(COPY.index).setDesc(COPY.indexOnDesc);
    if (value) setting.controlEl.createDiv({ cls: 'nexus-semantic-value', text: value });
  }

  private renderIndexing(itemsEl: HTMLElement, progress: IndexingProgress, paused: boolean): void {
    const setting = new Setting(itemsEl)
      .setName(COPY.indexing)
      .setDesc(paused ? COPY.indexingPausedDesc : COPY.indexingDesc(progress.estimatedTimeRemaining))
      .setClass('nexus-semantic-progress');

    let bar: ProgressBarComponent | null = null;
    setting.addProgressBar(component => {
      bar = component;
      component.setValue(percentOf(progress));
    });
    const valueEl = setting.controlEl.createDiv({
      cls: 'nexus-semantic-value',
      text: COPY.indexingProgress(progress.processedNotes, progress.totalNotes)
    });
    setting.addExtraButton(button => button
      .setIcon(paused ? 'play' : 'pause')
      .setTooltip(paused ? COPY.resumeIndexing : COPY.pauseIndexing)
      .onClick(() => {
        const runtime = this.deps.getRuntime();
        if (!runtime) return;
        if (paused) runtime.resumeIndexing();
        else runtime.pauseIndexing();
      }));

    this.indexingRow = { setting, bar, valueEl };
  }

  private renderIndexOff(itemsEl: HTMLElement): void {
    const counts = this.readyCounts();
    let value: string = COPY.indexPausedUnknown;
    if (counts) value = counts.total > 0 ? COPY.indexPaused(counts.notes) : COPY.noIndex;
    const index = new Setting(itemsEl).setName(COPY.index).setDesc(COPY.indexOffDesc);
    index.controlEl.createDiv({ cls: 'nexus-semantic-value', text: value });

    const nothingToDelete = counts !== null && counts.total === 0;
    new Setting(itemsEl)
      .setName(COPY.deleteIndex)
      .setDesc(COPY.deleteIndexDesc)
      .addButton(button => button
        .setButtonText(COPY.deleteIndex)
        .setWarning()
        .setDisabled(this.deleting || nothingToDelete || !this.deps.getRuntime())
        .onClick(() => { void this.onDeleteIndex(); }));
  }

  private async onToggle(enabled: boolean): Promise<void> {
    if (!enabled) {
      const confirmed = await this.deps.confirmTurnOff();
      if (!confirmed) {
        // Redraw from the saved value, which puts the switch back on.
        this.redraw();
        return;
      }
    }

    this.deps.setEnabled(enabled);
    this.invalidateCounts();
    this.redraw();

    try {
      await this.deps.applyEnabled(enabled);
    } catch (error) {
      console.error('[SemanticSearchSettings] Failed to apply semantic search:', error);
      new Notice(COPY.applyFailed);
    }
    this.invalidateCounts();
    this.redraw();
  }

  private async onDeleteIndex(): Promise<void> {
    const runtime = this.deps.getRuntime();
    if (this.deleting || !runtime) return;
    if (!(await this.deps.confirmDeleteIndex())) return;

    this.deleting = true;
    this.redraw();
    try {
      await runtime.deleteIndex();
    } catch (error) {
      console.error('[SemanticSearchSettings] Failed to delete the search index:', error);
      new Notice(error instanceof Error && error.message ? error.message : COPY.deleteFailed);
    } finally {
      this.deleting = false;
      this.invalidateCounts();
      this.redraw();
    }
  }

  private invalidateCounts(): void {
    this.countsRequest++;
    this.counts = { status: 'idle' };
  }

  private loadCounts(): void {
    const runtime = this.deps.getRuntime();
    if (!runtime) return;
    const request = ++this.countsRequest;
    this.counts = { status: 'loading' };
    void runtime.getStats().then(stats => {
      if (request !== this.countsRequest) return;
      this.counts = {
        status: 'ready',
        counts: {
          notes: stats.noteCount,
          chats: stats.conversationCount,
          total: stats.noteCount + stats.traceCount + stats.conversationChunkCount
        }
      };
      this.redraw();
    }).catch((error: unknown) => {
      if (request !== this.countsRequest) return;
      console.error('[SemanticSearchSettings] Failed to read index stats:', error);
      this.counts = { status: 'failed' };
      this.redraw();
    });
  }

  private subscribe(): void {
    const runtime = this.deps.getRuntime();
    if (!runtime || this.subscription?.runtime === runtime) return;
    this.subscription?.unsubscribe();
    this.subscription = { runtime, unsubscribe: runtime.onStateChange(() => this.onStateChange()) };
  }

  /**
   * The runtime is created in the background once storage is ready, and
   * nothing announces it. Without this a fold drawn first would read
   * "Starting" (and keep Delete index disabled) until settings were reopened.
   */
  private waitForRuntime(): void {
    if (this.runtimeWait !== null || this.destroyed || this.deps.getRuntime()) return;
    this.runtimeWait = window.setInterval(() => {
      if (this.destroyed) {
        this.stopWaitingForRuntime();
        return;
      }
      if (!this.deps.getRuntime()) return;
      this.stopWaitingForRuntime();
      // redraw() runs render(), which subscribes and loads the counts.
      this.invalidateCounts();
      this.redraw();
    }, RUNTIME_POLL_MS);
  }

  private stopWaitingForRuntime(): void {
    if (this.runtimeWait === null) return;
    window.clearInterval(this.runtimeWait);
    this.runtimeWait = null;
  }

  private onStateChange(): void {
    if (this.destroyed || !this.host) return;
    const view = this.view();
    if (view.key !== this.drawnKey) {
      // Started, stopped, paused or finished: counts may have moved too.
      this.invalidateCounts();
      this.redraw();
      return;
    }
    if (view.mode === 'indexing' && this.indexingRow) {
      const { setting, bar, valueEl } = this.indexingRow;
      bar?.setValue(percentOf(view.progress));
      valueEl.setText(COPY.indexingProgress(view.progress.processedNotes, view.progress.totalNotes));
      if (!view.paused) setting.setDesc(COPY.indexingDesc(view.progress.estimatedTimeRemaining));
    }
    this.host.setSummary(this.getSummary());
  }

  private redraw(): void {
    if (!this.destroyed) this.host?.redraw();
  }
}
