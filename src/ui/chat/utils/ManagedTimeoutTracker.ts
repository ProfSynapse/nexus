import type { Component } from 'obsidian';

export class ManagedTimeoutTracker {
  private ids = new Set<ReturnType<typeof setTimeout>>();

  constructor(component: Component) {
    // Ensure Component teardown cancels all pending timeouts automatically,
    // even if the caller forgets to invoke clear() explicitly.
    component.register(() => this.clear());
  }

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.ids.delete(id);
      callback();
    }, delayMs);
    this.ids.add(id);
    return id;
  }

  clear(): void {
    for (const id of this.ids) {
      clearTimeout(id);
    }
    this.ids.clear();
  }
}
