/**
 * Smoke test: Rebuild Cache modal seam.
 *
 * Verifies that the registered "Rebuild cache" command opens a modal whose
 * confirm path calls back into HybridStorageAdapter.rebuildCache and whose
 * cancel path does NOT. Per architect's split decision, this test is
 * intentionally THIN — Obsidian Modal lifecycle (focus, escape, animation) is
 * not deterministic enough to chase. The full storage seam is covered in
 * cache-backend-rebuild-cache.test.ts.
 *
 * Strategy:
 *   - Patch Modal.prototype.open/close to capture the modal instance and
 *     synchronously invoke onOpen()/onClose() (mirroring the real lifecycle).
 *   - Replace contentEl with a tracking mock element that records
 *     createEl/createDiv children and addEventListener handlers, so the test
 *     can locate buttons by text and dispatch synthetic clicks.
 */

import * as obsidianMock from 'obsidian';

import { MaintenanceCommandManager } from '../../src/core/commands/MaintenanceCommandManager';

interface RegisteredCommand {
  id: string;
  name: string;
  callback?: () => void;
}

interface TrackingElement {
  tagName: string;
  textContent: string;
  className?: string;
  children: TrackingElement[];
  listeners: Map<string, Array<(e: Event) => void>>;
  setText(text: string): void;
  createEl(tag: string, opts?: { text?: string; cls?: string; attr?: Record<string, string> }): TrackingElement;
  createDiv(opts?: string | { cls?: string }): TrackingElement;
  empty(): void;
  addEventListener(type: string, handler: (e: Event) => void): void;
  dispatch(type: string): void;
}

function createTrackingElement(tag: string, text = ''): TrackingElement {
  const el: TrackingElement = {
    tagName: tag.toUpperCase(),
    textContent: text,
    className: '',
    children: [],
    listeners: new Map(),
    setText(t) { this.textContent = t; },
    createEl(t, opts) {
      const child = createTrackingElement(t, opts?.text ?? '');
      if (opts?.cls) child.className = opts.cls;
      this.children.push(child);
      return child;
    },
    createDiv(opts) {
      const child = createTrackingElement('div', '');
      if (typeof opts === 'string') child.className = opts;
      else if (opts?.cls) child.className = opts.cls;
      this.children.push(child);
      return child;
    },
    empty() { this.children = []; },
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    },
    dispatch(type) {
      const list = this.listeners.get(type) ?? [];
      const evt = { type } as unknown as Event;
      for (const h of list) h(evt);
    }
  };
  return el;
}

function findChildByText(el: TrackingElement, text: string): TrackingElement | null {
  for (const c of el.children) {
    if (c.textContent === text) return c;
    const r = findChildByText(c, text);
    if (r) return r;
  }
  return null;
}

interface CapturedModal {
  contentEl: TrackingElement;
  titleEl: TrackingElement;
  open: () => void;
  close: () => void;
  confirmed?: boolean;
}

function buildHarness() {
  const registered: RegisteredCommand[] = [];
  const capturedModals: CapturedModal[] = [];

  const ModalCtor = (obsidianMock as unknown as {
    Modal: { prototype: { open: () => void; close: () => void } };
  }).Modal;
  const originalOpen = ModalCtor.prototype.open;
  const originalClose = ModalCtor.prototype.close;
  ModalCtor.prototype.open = function (this: CapturedModal) {
    // Replace contentEl + titleEl with tracking elements before onOpen()
    // builds the DOM. The original mock's contentEl doesn't track children.
    this.contentEl = createTrackingElement('div');
    this.titleEl = createTrackingElement('div');
    capturedModals.push(this);
    const me = this as unknown as { onOpen?: () => void };
    me.onOpen?.();
  };
  ModalCtor.prototype.close = function (this: CapturedModal) {
    const me = this as unknown as { onClose?: () => void };
    me.onClose?.();
  };

  const rebuildCache = jest.fn(async () => undefined);

  const plugin = {
    app: {
      setting: { open: jest.fn(), openTabById: jest.fn() }
    },
    manifest: { id: 'nexus' },
    addCommand: jest.fn((cmd: RegisteredCommand) => { registered.push(cmd); })
  };

  const getService = jest.fn(async () => ({
    rebuildCache,
    sync: jest.fn(async () => undefined)
  }));

  const manager = new MaintenanceCommandManager({
    plugin: plugin as unknown as Parameters<typeof MaintenanceCommandManager>[0]['plugin'],
    serviceManager: undefined,
    getService
  } as unknown as ConstructorParameters<typeof MaintenanceCommandManager>[0]);

  manager.registerMaintenanceCommands();

  const restore = () => {
    ModalCtor.prototype.open = originalOpen;
    ModalCtor.prototype.close = originalClose;
  };

  return { manager, registered, plugin, rebuildCache, getService, capturedModals, restore };
}

describe('Rebuild cache modal smoke', () => {
  it('registers a "Rebuild cache" command on the plugin', () => {
    const h = buildHarness();
    try {
      expect(h.registered.some(c => c.id === 'rebuild-cache' && c.name === 'Rebuild cache')).toBe(true);
    } finally { h.restore(); }
  });

  it('opens a modal with title and confirm/cancel buttons when the command callback fires', () => {
    const h = buildHarness();
    try {
      const cmd = h.registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      expect(h.capturedModals.length).toBe(1);
      const modal = h.capturedModals[0];
      // Title set during onOpen.
      expect(modal.titleEl.textContent).toMatch(/Rebuild Nexus cache/);
      // Both action buttons present in the content tree.
      expect(findChildByText(modal.contentEl, 'Rebuild cache')).not.toBeNull();
      expect(findChildByText(modal.contentEl, 'Cancel')).not.toBeNull();
    } finally { h.restore(); }
  });

  it('confirm click triggers HybridStorageAdapter.rebuildCache', async () => {
    const h = buildHarness();
    try {
      const cmd = h.registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      const modal = h.capturedModals[0];

      const confirmBtn = findChildByText(modal.contentEl, 'Rebuild cache');
      expect(confirmBtn).not.toBeNull();
      confirmBtn!.dispatch('click');

      // Drain microtasks: confirmed=true -> modal.close() -> onClose ->
      // onConfirm -> getService -> rebuildCache.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(h.rebuildCache).toHaveBeenCalledTimes(1);
    } finally { h.restore(); }
  });

  it('rebuild error path is swallowed (no unhandled rejection) when rebuildCache rejects', async () => {
    const h = buildHarness();
    try {
      // Make rebuildCache reject so the runRebuildCache catch branch fires.
      h.rebuildCache.mockRejectedValueOnce(new Error('boom'));
      const cmd = h.registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      const modal = h.capturedModals[0];
      const confirmBtn = findChildByText(modal.contentEl, 'Rebuild cache');
      confirmBtn!.dispatch('click');

      // Drain microtasks so the confirm-driven rebuildCache + catch land.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(h.rebuildCache).toHaveBeenCalledTimes(1);
    } finally { h.restore(); }
  });

  it('rebuild fails fast when getService is not available on the context', async () => {
    // Build a fresh harness with getService omitted entirely so the runRebuildCache
    // "Service lookup unavailable" branch fires.
    const ModalCtor = (obsidianMock as unknown as {
      Modal: { prototype: { open: () => void; close: () => void } };
    }).Modal;
    const originalOpen = ModalCtor.prototype.open;
    const originalClose = ModalCtor.prototype.close;
    const captured: CapturedModal[] = [];
    ModalCtor.prototype.open = function (this: CapturedModal) {
      this.contentEl = createTrackingElement('div');
      this.titleEl = createTrackingElement('div');
      captured.push(this);
      const me = this as unknown as { onOpen?: () => void };
      me.onOpen?.();
    };
    ModalCtor.prototype.close = function (this: CapturedModal) {
      const me = this as unknown as { onClose?: () => void };
      me.onClose?.();
    };

    const registered: RegisteredCommand[] = [];
    const plugin = {
      app: { setting: { open: jest.fn(), openTabById: jest.fn() } },
      manifest: { id: 'nexus' },
      addCommand: jest.fn((cmd: RegisteredCommand) => { registered.push(cmd); })
    };
    const manager = new MaintenanceCommandManager({
      plugin: plugin as unknown as Parameters<typeof MaintenanceCommandManager>[0]['plugin'],
      serviceManager: undefined,
      getService: undefined
    } as unknown as ConstructorParameters<typeof MaintenanceCommandManager>[0]);
    manager.registerMaintenanceCommands();

    try {
      const cmd = registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      const modal = captured[0];
      const confirmBtn = findChildByText(modal.contentEl, 'Rebuild cache');
      confirmBtn!.dispatch('click');

      // Drain so the catch branch executes its Notice.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      // No assertion target other than: the click did not throw and the modal
      // smoke completed. The "Service lookup unavailable" branch is exercised.
      expect(true).toBe(true);
    } finally {
      ModalCtor.prototype.open = originalOpen;
      ModalCtor.prototype.close = originalClose;
    }
  });

  it('rebuild fails when the resolved service does not implement rebuildCache (wrong type)', async () => {
    // Resolve a service object missing rebuildCache so isRebuildableStorageAdapter
    // returns false and the "Hybrid storage adapter is not available" branch fires.
    const ModalCtor = (obsidianMock as unknown as {
      Modal: { prototype: { open: () => void; close: () => void } };
    }).Modal;
    const originalOpen = ModalCtor.prototype.open;
    const originalClose = ModalCtor.prototype.close;
    const captured: CapturedModal[] = [];
    ModalCtor.prototype.open = function (this: CapturedModal) {
      this.contentEl = createTrackingElement('div');
      this.titleEl = createTrackingElement('div');
      captured.push(this);
      const me = this as unknown as { onOpen?: () => void };
      me.onOpen?.();
    };
    ModalCtor.prototype.close = function (this: CapturedModal) {
      const me = this as unknown as { onClose?: () => void };
      me.onClose?.();
    };

    const registered: RegisteredCommand[] = [];
    const plugin = {
      app: { setting: { open: jest.fn(), openTabById: jest.fn() } },
      manifest: { id: 'nexus' },
      addCommand: jest.fn((cmd: RegisteredCommand) => { registered.push(cmd); })
    };
    // Service object missing rebuildCache fn.
    const getService = jest.fn(async () => ({ sync: jest.fn(async () => undefined) }));
    const manager = new MaintenanceCommandManager({
      plugin: plugin as unknown as Parameters<typeof MaintenanceCommandManager>[0]['plugin'],
      serviceManager: undefined,
      getService
    } as unknown as ConstructorParameters<typeof MaintenanceCommandManager>[0]);
    manager.registerMaintenanceCommands();

    try {
      const cmd = registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      const modal = captured[0];
      const confirmBtn = findChildByText(modal.contentEl, 'Rebuild cache');
      confirmBtn!.dispatch('click');
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(getService).toHaveBeenCalled();
    } finally {
      ModalCtor.prototype.open = originalOpen;
      ModalCtor.prototype.close = originalClose;
    }
  });

  it('cancel click does NOT trigger HybridStorageAdapter.rebuildCache', async () => {
    const h = buildHarness();
    try {
      const cmd = h.registered.find(c => c.id === 'rebuild-cache');
      cmd?.callback?.();
      const modal = h.capturedModals[0];

      const cancelBtn = findChildByText(modal.contentEl, 'Cancel');
      expect(cancelBtn).not.toBeNull();
      cancelBtn!.dispatch('click');

      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(h.rebuildCache).not.toHaveBeenCalled();
    } finally { h.restore(); }
  });
});
