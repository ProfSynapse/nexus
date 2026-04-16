import type { Component } from 'obsidian';
import { ManagedTimeoutTracker } from '../utils/ManagedTimeoutTracker';
import type { ToolStatusEntry } from '../types/ToolStatus';

export type { ToolStatusEntry };

export class ToolStatusLine {
  private currentSlot: HTMLElement | null = null;
  private lastUpdate = 0;
  private queuedEntry: ToolStatusEntry | null = null;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private timeouts: ManagedTimeoutTracker;

  constructor(private readonly slot: HTMLElement, component: Component) {
    this.timeouts = new ManagedTimeoutTracker(component);
  }

  public update(text: string, state: ToolStatusEntry['state']): void {
    const entry = { text, state };
    const elapsed = Date.now() - this.lastUpdate;

    if (this.lastUpdate !== 0 && elapsed < 400) {
      this.queuedEntry = entry;
      if (!this.pendingTimeout) {
        this.pendingTimeout = this.timeouts.setTimeout(() => {
          this.pendingTimeout = null;
          if (this.queuedEntry) {
            const queued = this.queuedEntry;
            this.queuedEntry = null;
            this.forceUpdate(queued);
          }
        }, 400 - elapsed);
      }
      return;
    }

    this.forceUpdate(entry);
  }

  public clear(): void {
    this.pendingTimeout = null;
    this.timeouts.clear();
    this.queuedEntry = null;
    this.lastUpdate = 0;
    if (this.currentSlot) {
      this.currentSlot.remove();
      this.currentSlot = null;
    }
  }

  private forceUpdate(entry: ToolStatusEntry): void {
    this.lastUpdate = Date.now();

    if (this.currentSlot) {
      const oldSlot = this.currentSlot;
      oldSlot.classList.add('exiting');
      this.timeouts.setTimeout(() => oldSlot.remove(), 200);
    }

    const nextSlot = this.slot.createEl('div', {
      cls: `tool-status-text-${entry.state} entering`,
      text: entry.text,
    });

    this.currentSlot = nextSlot;
    this.timeouts.setTimeout(() => {
      nextSlot.removeClass('entering');
      nextSlot.addClass('active');
    }, 100);
  }
}
