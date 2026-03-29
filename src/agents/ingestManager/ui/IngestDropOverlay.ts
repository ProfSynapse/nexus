/**
 * IngestDropOverlay - Full-chat drop target overlay
 * Location: /src/agents/ingestManager/ui/IngestDropOverlay.ts
 *
 * Shown on dragenter when files are being dragged over the chat view.
 * Hidden on dragleave or drop. Shows an icon and instructional message.
 */

import { setIcon } from 'obsidian';
import { ACCEPTED_EXTENSIONS } from '../types';

export class IngestDropOverlay {
  private overlayEl: HTMLElement;
  private iconEl: HTMLElement;
  private textEl: HTMLElement;

  constructor(parentEl: HTMLElement) {
    this.overlayEl = parentEl.createDiv({ cls: 'nexus-ingest-drop-overlay' });

    const content = this.overlayEl.createDiv({ cls: 'nexus-ingest-drop-overlay-content' });

    this.iconEl = content.createDiv({ cls: 'nexus-ingest-drop-overlay-icon' });
    setIcon(this.iconEl, 'file-plus');

    this.textEl = content.createDiv({ cls: 'nexus-ingest-drop-overlay-text' });
    this.textEl.textContent = 'Drop PDF or audio file to ingest';

    const hint = content.createDiv({ cls: 'nexus-ingest-drop-overlay-hint' });
    hint.textContent = ACCEPTED_EXTENSIONS.join(', ');

    this.overlayEl.setAttribute('role', 'region');
    this.overlayEl.setAttribute('aria-label', 'File drop zone for ingestion');
    this.hide();
  }

  show(): void {
    this.overlayEl.removeClass('nexus-ingest-drop-overlay-hidden');
    this.overlayEl.addClass('nexus-ingest-drop-overlay-visible');
  }

  hide(): void {
    this.overlayEl.removeClass('nexus-ingest-drop-overlay-visible');
    this.overlayEl.addClass('nexus-ingest-drop-overlay-hidden');
  }

  isVisible(): boolean {
    return this.overlayEl.hasClass('nexus-ingest-drop-overlay-visible');
  }

  destroy(): void {
    this.overlayEl.remove();
  }
}
