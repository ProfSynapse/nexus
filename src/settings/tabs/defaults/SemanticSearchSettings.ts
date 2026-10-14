/**
 * The Semantic search fold on Defaults (desktop only).
 *
 * For now it hosts the existing `enableEmbeddings` switch, which still takes
 * effect after a restart. `render(container)` is the single entry point: index
 * status, progress, pause and delete rows are meant to be added here, and the
 * class can be used on its own or as a fold through `FoldDefinition`.
 */

import { Notice, Setting } from 'obsidian';
import { FOLD_ICONS, FOLD_IDS, FOLD_TITLES, SEMANTIC_COPY } from '../../../components/shared/chatSettings/copy';
import { semanticSearchSummary } from '../../../components/shared/chatSettings/sectionSummaries';
import type { FoldDefinition, FoldHost } from '../../../components/shared/chatSettings/types';

export interface SemanticSearchDeps {
  isEnabled(): boolean;
  /** Persist the switch (through the Defaults save queue). */
  setEnabled(enabled: boolean): void;
}

export class SemanticSearchSettings implements FoldDefinition {
  readonly id = FOLD_IDS.semanticSearch;
  readonly title = FOLD_TITLES.semanticSearch;
  readonly icon = FOLD_ICONS.semanticSearch;
  private host: FoldHost | null = null;

  constructor(private readonly deps: SemanticSearchDeps) {}

  getSummary(): string {
    return semanticSearchSummary({ enabled: this.deps.isEnabled() });
  }

  /** Draw the rows into `container` (a fold's `setting-items` list). */
  render(container: HTMLElement, host?: FoldHost): void {
    this.host = host ?? null;
    new Setting(container)
      .setName(SEMANTIC_COPY.toggle)
      .setDesc(SEMANTIC_COPY.toggleDesc)
      .addToggle(toggle => toggle
        .setValue(this.deps.isEnabled())
        .onChange(value => {
          this.deps.setEnabled(value);
          new Notice(SEMANTIC_COPY.restartNotice(value));
          this.host?.setSummary(this.getSummary());
        }));
    this.host?.setSummary(this.getSummary());
  }

  destroy(): void {
    this.host = null;
  }
}
