/**
 * Obsidian view/lifecycle mocks: Modal, Scope, Component, Plugin, Menu.
 */

import { createMockElement, App, EventRef } from './core';

// Scope mock
export class Scope {
  register(): void {
    // Mock implementation
  }
}

// Modal mock
export class Modal {
  app: App;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  scope: Scope;

  constructor(app: App) {
    this.app = app;
    this.contentEl = createMockElement('div');
    this.containerEl = createMockElement('div');
    this.scope = new Scope();
  }

  open(): void {
    // Mock implementation
  }

  close(): void {
    // Mock implementation
  }

  onOpen(): void {
    // Override in subclass
  }

  onClose(): void {
    // Override in subclass
  }
}

// Component mock (base class for UI components like MessageBubble)
export class Component {
  private _domEvents: Array<{ el: any; type: string; handler: any }> = [];
  private _intervals: any[] = [];
  private _isLoaded = false;

  load(): void {
    this._isLoaded = true;
  }

  onload(): void {
    // Override in subclass
  }

  unload(): void {
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
  }

  onunload(): void {
    // Override in subclass
  }

  registerDomEvent(el: any, type: string, handler: any): void {
    this._domEvents.push({ el, type, handler });
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(type, handler);
    }
  }

  registerInterval(interval: any): number {
    this._intervals.push(interval);
    return interval;
  }

  registerEvent(eventRef: EventRef): void {
    // Mock implementation
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
    // Mock implementation
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
  setTitle(title: string): this {
    return this;
  }

  setIcon(icon: string): this {
    return this;
  }

  onClick(callback: () => void): this {
    return this;
  }
}
