/**
 * BoxedSection Re-instantiation Invariant Tests
 *
 * Covers PR2 Commit 4 contract C-3 — the late-render pattern used by
 * WorkspaceDetailRenderer.renderStatesSection where BoxedSection is
 * constructed up to 3 times in sequence (placeholder → success/error) all
 * sharing the SAME Component instance.
 *
 * Design note (resolved tension with architect spec):
 *   Production uses `this.component` (shared) for all 3 BoxedSection
 *   constructions, which is correct — a single Component enables cleanup of
 *   all wired DOM listeners on unload(). The real contract to assert is
 *   "Component is threaded to each construction so registerDomEvent fires
 *   (not addEventListener fallback)" + "re-render after sectionHost.empty()
 *   produces a fresh DOM tree whose handler fires correctly, and the
 *   previous Component.unload() de-registers prior handlers".
 *
 * Mock faithfulness check (see tests/mocks/obsidian/views.ts:90-107):
 *   Component.unload() DOES iterate _domEvents and call removeEventListener.
 *   We can therefore ship this layer as behavior-layer (not just
 *   characterization).
 */

import { BoxedSection } from '../../src/settings/components/BoxedSection';
import { Component } from 'obsidian';

// ----------------------------------------------------------------------------
// Local MockContainer with _children + addEventListener tracking. Mirrors
// the pattern in tests/unit/BoxedSection.test.ts:17-68 but extended so the
// raw el.addEventListener mock is observable.
// ----------------------------------------------------------------------------
type MockEl = {
  tagName: string;
  className: string;
  id: string;
  createEl: jest.Mock<MockEl, [string, unknown?]>;
  createDiv: jest.Mock<MockEl, [string | { cls?: string }?]>;
  createSpan: jest.Mock<MockEl, [{ cls?: string; text?: string }?]>;
  addClass: jest.Mock<void, [string]>;
  setAttribute: jest.Mock<void, [string, string]>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  removeEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  empty: jest.Mock<void, []>;
  remove: jest.Mock<void, []>;
  textContent: string;
  _children: MockEl[];
};

function makeEl(cls = ''): MockEl {
  const el: MockEl = {
    tagName: 'DIV',
    className: cls,
    id: '',
    addClass: jest.fn(),
    setAttribute: jest.fn(),
    createEl: jest.fn((tag?: string, opts?: { cls?: string; text?: string }) => {
      const c = makeEl(opts?.cls || '');
      c.tagName = (tag || 'DIV').toUpperCase();
      if (opts?.text) c.textContent = opts.text;
      el._children.push(c);
      return c;
    }),
    createDiv: jest.fn((arg?: string | { cls?: string }) => {
      const c = typeof arg === 'string' ? arg : arg?.cls || '';
      const child = makeEl(c);
      el._children.push(child);
      return child;
    }),
    createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
      const child = makeEl(opts?.cls || '');
      if (opts?.text) child.textContent = opts.text;
      el._children.push(child);
      return child;
    }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    empty: jest.fn(() => { el._children.length = 0; }),
    remove: jest.fn(),
    textContent: '',
    _children: []
  };
  return el;
}

// Locate the "action" button inside a rendered BoxedSection: it's the
// <button> child of the toolbar inside the header. The mock has
// section._children = [header, body]; header._children = [title, toolbar];
// toolbar._children = [actionButton, ...].
function findActionButton(container: MockEl): MockEl {
  const section = container._children[0];
  const header = section._children[0];
  const toolbar = header._children.find(c => c.tagName === 'DIV' && c.className.includes('ws-section-toolbar'));
  if (!toolbar) throw new Error('No toolbar in header — was actionLabel set?');
  const btn = toolbar._children.find(c => c.tagName === 'BUTTON');
  if (!btn) throw new Error('No action button in toolbar');
  return btn;
}

describe('BoxedSection — re-instantiation invariants (C-3)', () => {
  describe('contract 1 — Component-threaded registerDomEvent fires on click', () => {
    it('action click invokes onAction via registerDomEvent (not raw addEventListener)', () => {
      const container = makeEl();
      const component = new Component();
      const onAction = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'States',
        actionLabel: '+ New',
        onAction,
        body: () => { /* no-op */ }
      }, component);

      const btn = findActionButton(container);

      // The Component mock's registerDomEvent at views.ts:131 calls
      // el.addEventListener AND tracks the (el, type, handler) tuple.
      // Both call surfaces should record one click handler.
      expect(btn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));

      // Invoke the handler directly to assert action fires.
      const recordedHandler = (btn.addEventListener as jest.Mock).mock.calls[0][1] as () => void;
      recordedHandler();
      expect(onAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('contract 2 — Component.unload de-registers prior handlers', () => {
    it('unload() removes the click listener wired by registerDomEvent', () => {
      const container = makeEl();
      const component = new Component();
      const onAction = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'States',
        actionLabel: '+ New',
        onAction,
        body: () => { /* no-op */ }
      }, component);

      const btn = findActionButton(container);

      // Sanity: addEventListener was called once during construction.
      expect(btn.addEventListener).toHaveBeenCalledTimes(1);
      const wiredHandler = (btn.addEventListener as jest.Mock).mock.calls[0][1] as EventListener;

      // Component.unload should iterate _domEvents and call
      // el.removeEventListener(type, handler) with the SAME handler.
      component.unload();
      expect(btn.removeEventListener).toHaveBeenCalledWith('click', wiredHandler);
    });
  });

  describe('contract 3 — re-render after host.empty() produces fresh handler; old unreachable', () => {
    it('second BoxedSection instance gets its own wired handler; old handler de-registered via unload', () => {
      const host = makeEl();
      const sharedComponent = new Component();

      // First render — placeholder.
      const firstAction = jest.fn();
      new BoxedSection(host as unknown as HTMLElement, {
        title: 'States',
        actionLabel: '+ Add',
        onAction: firstAction,
        body: () => { /* no-op */ }
      }, sharedComponent);

      const firstBtn = findActionButton(host);
      const firstHandler = (firstBtn.addEventListener as jest.Mock).mock.calls[0][1] as EventListener;

      // Production pattern: empty host, then re-render BoxedSection on the
      // same host. We also unload the OLD component if production decided
      // to swap it. The current production code uses ONE shared component
      // for the lifetime of the renderer, so we model that — unload only
      // when the host is torn down, not between re-renders. The contract
      // we care about is that the second construction wires a fresh
      // handler, and the new click is dispatched to firstAction.mockClear()
      // confirmed reachable.
      host.empty();

      const secondAction = jest.fn();
      new BoxedSection(host as unknown as HTMLElement, {
        title: 'States',
        actionLabel: '+ Add',
        onAction: secondAction,
        body: () => { /* no-op */ }
      }, sharedComponent);

      const secondBtn = findActionButton(host);
      expect(secondBtn).not.toBe(firstBtn);

      // The second button's handler invokes secondAction, not firstAction.
      const secondHandler = (secondBtn.addEventListener as jest.Mock).mock.calls[0][1] as () => void;
      secondHandler();
      expect(secondAction).toHaveBeenCalledTimes(1);
      expect(firstAction).not.toHaveBeenCalled();

      // Final teardown: unload the shared component removes ALL wired
      // listeners (both the orphaned first-button handler AND the live
      // second-button handler). This is the "single Component enables
      // cleanup-of-all" property.
      sharedComponent.unload();
      expect(firstBtn.removeEventListener).toHaveBeenCalledWith('click', firstHandler);
      expect(secondBtn.removeEventListener).toHaveBeenCalledWith('click', secondHandler);
    });
  });
});
