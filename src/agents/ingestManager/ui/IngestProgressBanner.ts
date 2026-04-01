/**
 * IngestProgressBanner - Progress banner shown during file ingestion
 * Location: /src/agents/ingestManager/ui/IngestProgressBanner.ts
 *
 * Displays filename, processing stage label, and an optional progress bar.
 * Multiple banners can stack for batch drops.
 * Completed/error banners show a dismiss button.
 */

import { setIcon } from 'obsidian';
import type { IngestProgress } from '../types';
import { ACCEPTED_AUDIO_EXTENSIONS } from '../types';

const STAGE_LABELS: Record<IngestProgress['stage'], string> = {
  queued: 'Queued',
  extracting: 'Extracting text...',
  transcribing: 'Transcribing audio...',
  building: 'Building note...',
  complete: 'Complete',
  error: 'Error'
};

export class IngestProgressBanner {
  private containerEl: HTMLElement;
  private banners: Map<string, HTMLElement> = new Map();
  private dismissHandlers: Map<string, { el: HTMLElement; handler: () => void }> = new Map();

  constructor(parentEl: HTMLElement) {
    this.containerEl = parentEl.createDiv({ cls: 'nexus-ingest-progress-container' });
    this.containerEl.setAttribute('aria-live', 'polite');
  }

  /**
   * Update progress for a file. Creates banner if it doesn't exist.
   */
  update(progress: IngestProgress): void {
    const key = progress.filePath;
    let bannerEl = this.banners.get(key);

    if (!bannerEl) {
      bannerEl = this.createBanner(progress);
      this.banners.set(key, bannerEl);
    }

    this.updateBanner(bannerEl, progress);
  }

  /**
   * Remove a specific banner
   */
  remove(filePath: string): void {
    const entry = this.dismissHandlers.get(filePath);
    if (entry) {
      entry.el.removeEventListener('click', entry.handler);
      this.dismissHandlers.delete(filePath);
    }
    const bannerEl = this.banners.get(filePath);
    if (bannerEl) {
      bannerEl.remove();
      this.banners.delete(filePath);
    }
  }

  /**
   * Remove all banners
   */
  clear(): void {
    this.dismissHandlers.forEach(entry => entry.el.removeEventListener('click', entry.handler));
    this.dismissHandlers.clear();
    this.banners.forEach(el => el.remove());
    this.banners.clear();
  }

  destroy(): void {
    this.clear();
    this.containerEl.remove();
  }

  private createBanner(progress: IngestProgress): HTMLElement {
    const banner = this.containerEl.createDiv({ cls: 'nexus-ingest-progress-banner' });

    // File icon
    const iconEl = banner.createDiv({ cls: 'nexus-ingest-progress-icon' });
    const ext = this.getExtension(progress.filePath);
    setIcon(iconEl, this.getIconForExtension(ext));

    // Info section
    const infoEl = banner.createDiv({ cls: 'nexus-ingest-progress-info' });

    // Filename
    const filenameEl = infoEl.createDiv({ cls: 'nexus-ingest-progress-filename' });
    filenameEl.textContent = this.getFilename(progress.filePath);

    // Stage label
    infoEl.createDiv({ cls: 'nexus-ingest-progress-stage' });

    // Progress bar container
    const barContainer = infoEl.createDiv({ cls: 'nexus-ingest-progress-bar-container' });
    barContainer.createDiv({ cls: 'nexus-ingest-progress-bar-fill' });

    // Dismiss button (hidden by default, shown for complete/error)
    const dismissBtn = banner.createEl('button', { cls: 'nexus-ingest-progress-dismiss' });
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    setIcon(dismissBtn, 'x');
    const dismissHandler = () => this.remove(progress.filePath);
    dismissBtn.addEventListener('click', dismissHandler);
    this.dismissHandlers.set(progress.filePath, { el: dismissBtn, handler: dismissHandler });

    return banner;
  }

  private updateBanner(bannerEl: HTMLElement, progress: IngestProgress): void {
    // Update stage class
    bannerEl.className = 'nexus-ingest-progress-banner';
    bannerEl.addClass(`nexus-ingest-progress-${progress.stage}`);

    // Update stage label
    const stageEl = bannerEl.querySelector('.nexus-ingest-progress-stage');
    if (stageEl) {
      stageEl.textContent = progress.error
        ? progress.error
        : STAGE_LABELS[progress.stage];
    }

    // Update progress bar
    const barFill = bannerEl.querySelector<HTMLElement>('.nexus-ingest-progress-bar-fill');
    if (barFill && progress.progress !== undefined) {
      barFill.style.width = `${Math.min(100, Math.max(0, progress.progress))}%`;
    }

    // Show dismiss for complete/error states
    const dismissBtn = bannerEl.querySelector('.nexus-ingest-progress-dismiss');
    if (dismissBtn) {
      if (progress.stage === 'complete' || progress.stage === 'error') {
        dismissBtn.removeClass('nexus-ingest-progress-dismiss-hidden');
      } else {
        dismissBtn.addClass('nexus-ingest-progress-dismiss-hidden');
      }
    }
  }

  private getFilename(filePath: string): string {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }

  private getExtension(filePath: string): string {
    const dot = filePath.lastIndexOf('.');
    return dot >= 0 ? filePath.substring(dot).toLowerCase() : '';
  }

  private getIconForExtension(ext: string): string {
    if (ext === '.pdf') return 'file-text';
    if ((ACCEPTED_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
      return 'headphones';
    }
    return 'file';
  }
}
