export interface ToolStatusEntry {
  text: string;
  state: 'present' | 'past' | 'failed';
}

export class ToolStatusLine {
  private currentSlot: HTMLElement | null = null;
  private lastUpdate = 0;
  private queuedEntry: ToolStatusEntry | null = null;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly slot: HTMLElement) {}

  public update(text: string, state: ToolStatusEntry['state']): void {
    const entry = { text, state };
    const elapsed = Date.now() - this.lastUpdate;

    if (this.lastUpdate !== 0 && elapsed < 400) {
      this.queuedEntry = entry;
      if (!this.pendingTimeout) {
        this.pendingTimeout = setTimeout(() => {
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
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
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
      setTimeout(() => oldSlot.remove(), 200);
    }

    const nextSlot = this.slot.createEl('div', {
      cls: `tool-status-text-${entry.state} entering`,
      text: entry.text,
    });

    this.currentSlot = nextSlot;
    setTimeout(() => {
      nextSlot.removeClass('entering');
      nextSlot.addClass('active');
    }, 100);
  }
}