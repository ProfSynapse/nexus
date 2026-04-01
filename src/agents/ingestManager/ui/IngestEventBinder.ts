/**
 * IngestEventBinder - Wires drag-drop events to ChatView container
 * Location: /src/agents/ingestManager/ui/IngestEventBinder.ts
 *
 * Manages the lifecycle of drag-and-drop event listeners on the chat container.
 * Shows the drop overlay when files are dragged over, hides on leave/drop.
 * Calls onFiles callback with dropped FileList for further processing.
 */

import { Plugin } from 'obsidian';
import { IngestDropOverlay } from './IngestDropOverlay';
import { ACCEPTED_EXTENSIONS } from '../types';

const ACCEPTED_EXTENSIONS_SET = new Set<string>(ACCEPTED_EXTENSIONS);

export class IngestEventBinder {
  private containerEl: HTMLElement;
  private plugin: Plugin;
  private onFiles: (files: FileList) => void;
  private overlay: IngestDropOverlay;
  private dragCounter = 0;
  private bound = false;

  // Store bound handlers for cleanup
  private handleDragEnter: (e: DragEvent) => void;
  private handleDragOver: (e: DragEvent) => void;
  private handleDragLeave: (e: DragEvent) => void;
  private handleDrop: (e: DragEvent) => void;

  constructor(containerEl: HTMLElement, plugin: Plugin, onFiles: (files: FileList) => void) {
    this.containerEl = containerEl;
    this.plugin = plugin;
    this.onFiles = onFiles;
    this.overlay = new IngestDropOverlay(containerEl);

    this.handleDragEnter = this.onDragEnter.bind(this);
    this.handleDragOver = this.onDragOver.bind(this);
    this.handleDragLeave = this.onDragLeave.bind(this);
    this.handleDrop = this.onDrop.bind(this);
  }

  bind(): void {
    if (this.bound) return;
    this.bound = true;

    this.plugin.registerDomEvent(this.containerEl, 'dragenter', this.handleDragEnter);
    this.plugin.registerDomEvent(this.containerEl, 'dragover', this.handleDragOver);
    this.plugin.registerDomEvent(this.containerEl, 'dragleave', this.handleDragLeave);
    this.plugin.registerDomEvent(this.containerEl, 'drop', this.handleDrop);
  }

  unbind(): void {
    // Note: registerDomEvent listeners are only removed on plugin unload,
    // not here. This method resets local state and hides the overlay.
    // Re-calling bind() after unbind() is safe due to the `this.bound` guard.
    this.overlay.hide();
    this.dragCounter = 0;
    this.bound = false;
  }

  destroy(): void {
    this.unbind();
    this.overlay.destroy();
  }

  private hasFiles(e: DragEvent): boolean {
    if (!e.dataTransfer) return false;
    // Check types for file presence
    return Array.from(e.dataTransfer.types).includes('Files');
  }

  private hasAcceptedFiles(files: FileList): boolean {
    for (let i = 0; i < files.length; i++) {
      const name = files[i].name.toLowerCase();
      const ext = name.substring(name.lastIndexOf('.'));
      if (ACCEPTED_EXTENSIONS_SET.has(ext)) return true;
    }
    return false;
  }

  private onDragEnter(e: DragEvent): void {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragCounter++;
    if (this.dragCounter === 1) {
      this.overlay.show();
    }
  }

  private onDragOver(e: DragEvent): void {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }

  private onDragLeave(_e: DragEvent): void {
    this.dragCounter--;
    if (this.dragCounter <= 0) {
      this.dragCounter = 0;
      this.overlay.hide();
    }
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragCounter = 0;
    this.overlay.hide();

    if (!e.dataTransfer?.files?.length) return;

    // Filter to only accepted file types
    if (this.hasAcceptedFiles(e.dataTransfer.files)) {
      this.onFiles(e.dataTransfer.files);
    }
  }
}
