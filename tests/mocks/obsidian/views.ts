/**
 * Obsidian view/lifecycle mocks: Modal, Scope, Component, Plugin, Menu.
 */

import { createMockElement, App, EventRef } from './core';

// Scope mock
export class Scope {
  register(): void {
    void 0;
  }
}

// Modal mock
export class Modal {
  app: App;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  scope: Scope;

  // Mirror of Component.register — Modal extends Component at runtime
  private _cleanups: Array<() => void> = [];
  private _domEvents: Array<{ el: HTMLElement; type: string; handler: EventListenerOrEventListenerObject }> = [];

  constructor(app: App) {
    this.app = app;
    this.contentEl = createMockElement('div');
    this.containerEl = createMockElement('div');
    this.modalEl = createMockElement('div');
    this.titleEl = createMockElement('div');
    this.scope = new Scope();
  }

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
    // Mirror Obsidian cleanup on close
    for (const cb of this._cleanups) {
      try { cb(); } catch { /* best effort */ }
    }
    this._cleanups = [];
    for (const { el, type, handler } of this._domEvents) {
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(type, handler);
      }
    }
    this._domEvents = [];
  }

  onOpen(): void {
    void 0;
  }

  onClose(): void {
    void 0;
  }

  register(cb: () => void): void {
    this._cleanups.push(cb);
  }

  registerDomEvent(el: HTMLElement, type: string, handler: EventListenerOrEventListenerObject): void {
    this._domEvents.push({ el, type, handler });
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(type, handler);
    }
  }
}

// Component mock (base class for UI components like MessageBubble)
export class Component {
  private _domEvents: Array<{ el: HTMLElement; type: string; handler: EventListenerOrEventListenerObject }> = [];
  private _intervals: Array<ReturnType<typeof setInterval>> = [];
  private _cleanups: Array<() => void> = [];
  private _isLoaded = false;

  load(): void {
    this._isLoaded = true;
  }

  onload(): void {
    void 0;
  }

  unload(): void {
    // Run registered cleanup callbacks (Obsidian's Component.register)
    for (const cb of this._cleanups) {
      try {
        cb();
      } catch {
        // Swallow cleanup errors — match Obsidian's best-effort teardown semantics
      }
    }
    this._cleanups = [];

    // Clean up registered DOM events
    for (const { el, type, handler } of this._domEvents) {
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(type, handler);
      }
    }
    this._domEvents = [];

    // Clean up intervals
    for (const interval of this._intervals) {
      clearInterval(interval);
    }
    this._intervals = [];

    this._isLoaded = false;
    this.onunload();
  }

  onunload(): void {
    void 0;
  }

  /**
   * Register a cleanup callback invoked during unload().
   * Mirrors Obsidian's Component.register(cb) API.
   */
  register(cb: () => void): void {
    this._cleanups.push(cb);
  }

  registerDomEvent(el: HTMLElement, type: string, handler: EventListenerOrEventListenerObject): void {
    this._domEvents.push({ el, type, handler });
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(type, handler);
    }
  }

  registerInterval(interval: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
    this._intervals.push(interval);
    return interval;
  }

  registerEvent(eventRef: EventRef): void {
    void eventRef;
  }
}

// Plugin mock
export class Plugin extends Component {
  app: App;
  manifest: { id: string; name: string; version: string };

  constructor(app: App, manifest: { id: string; name: string; version: string }) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: { id: string; name: string; callback?: () => void }): void {
    void command;
  }
}

// Menu mock
export class Menu {
  addItem(callback: (item: MenuItem) => void): this {
    callback(new MenuItem());
    return this;
  }
}

// MenuItem mock
export class MenuItem {
  setTitle(_title: string): this {
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  onClick(_callback: () => void): this {
    return this;
  }
}
