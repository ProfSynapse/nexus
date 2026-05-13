import type { Component } from 'obsidian';

export class ManagedTimeoutTracker {
  private ids = new Set<number>();

  constructor(component: Component) {
    // Ensure Component teardown cancels all pending timeouts automatically,
    // even if the caller forgets to invoke clear() explicitly.
    component.register(() => this.clear());
  }

  schedule(callback: () => void, delayMs: number): number {
    const id = window.setTimeout(() => {
      this.ids.delete(id);
      callback();
    }, delayMs);
    this.ids.add(id);
    return id;
  }

  clear(): void {
    for (const id of this.ids) {
      window.clearTimeout(id);
    }
    this.ids.clear();
  }
}
