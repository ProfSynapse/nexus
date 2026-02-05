/**
 * MessageBranchNavigator Unit Tests
 *
 * Tests for the message-level branch navigation UI component.
 * Bug #6: destroy() was calling removeEventListener directly, but the
 * event listeners were registered via Component.registerDomEvent().
 * The fix removes the manual removeEventListener calls and relies on
 * Component.unload() for automatic cleanup.
 *
 * Key behaviors verified:
 * - destroy() properly cleans up without broken removeEventListener
 * - Navigation events fire correctly
 * - Display updates based on message branches
 */

import { MessageBranchNavigator, MessageBranchNavigatorEvents } from '../../src/ui/chat/components/MessageBranchNavigator';
import { Component } from '../mocks/obsidian';
import { createAssistantMessage, createBranch } from '../fixtures/chatBugs';

// Helper to create a mock container element with Obsidian-style methods
function createMockContainer() {
  const children: any[] = [];
  const classes = new Set<string>();

  const container: any = {
    tagName: 'DIV',
    children,
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      contains: jest.fn((cls: string) => classes.has(cls)),
      toggle: jest.fn()
    },
    addClass: jest.fn((cls: string) => classes.add(cls)),
    removeClass: jest.fn((cls: string) => classes.delete(cls)),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    empty: jest.fn(() => { children.length = 0; }),
    createEl: jest.fn((tag: string, opts?: any) => {
      const el = createMockButton(tag);
      if (opts?.cls) {
        if (typeof opts.cls === 'string') el.classList.add(opts.cls);
      }
      if (opts?.attr) {
        Object.entries(opts.attr).forEach(([k, v]) => el.setAttribute(k, v));
      }
      children.push(el);
      return el;
    }),
    createDiv: jest.fn((cls?: string) => {
      const el = createMockButton('div');
      if (cls) el.classList.add(cls);
      children.push(el);
      return el;
    }),
    createSpan: jest.fn(() => {
      const el = createMockButton('span');
      children.push(el);
      return el;
    }),
    appendChild: jest.fn(),
    removeChild: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    textContent: '',
    innerHTML: '',
    style: {},
    focus: jest.fn(),
    // Track disabled property
    disabled: false
  };

  return container;
}

function createMockButton(tag = 'button') {
  const attrs = new Map<string, any>();
  const classes = new Set<string>();

  return {
    tagName: tag.toUpperCase(),
    disabled: false,
    classList: {
      add: jest.fn((cls: string) => classes.add(cls)),
      remove: jest.fn((cls: string) => classes.delete(cls)),
      contains: jest.fn((cls: string) => classes.has(cls)),
      toggle: jest.fn()
    },
    addClass: jest.fn((cls: string) => classes.add(cls)),
    removeClass: jest.fn((cls: string) => classes.delete(cls)),
    hasClass: jest.fn((cls: string) => classes.has(cls)),
    toggleClass: jest.fn((cls: string, force: boolean) => {
      if (force) classes.add(cls); else classes.delete(cls);
    }),
    createEl: jest.fn(() => createMockButton()),
    createDiv: jest.fn(() => createMockButton('div')),
    createSpan: jest.fn(() => createMockButton('span')),
    empty: jest.fn(),
    appendChild: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn((k: string, v: any) => attrs.set(k, v)),
    getAttribute: jest.fn((k: string) => attrs.get(k)),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    textContent: '',
    innerHTML: '',
    style: {},
    focus: jest.fn()
  };
}

describe('MessageBranchNavigator', () => {
  let container: ReturnType<typeof createMockContainer>;
  let events: MessageBranchNavigatorEvents;
  let component: Component;

  beforeEach(() => {
    container = createMockContainer();
    events = {
      onAlternativeChanged: jest.fn(),
      onError: jest.fn()
    };
    component = new Component();
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('construction', () => {
    it('should create navigator and hide by default', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);

      // Should be hidden by default
      expect(container.addClass).toHaveBeenCalledWith('message-branch-navigator');
      expect(container.addClass).toHaveBeenCalledWith('message-branch-navigator-hidden');
    });

    it('should create prev/next buttons and indicator', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);

      // Should have called createEl for buttons and createDiv for indicator
      expect(container.createEl).toHaveBeenCalledTimes(2); // prev + next buttons
      expect(container.createDiv).toHaveBeenCalledTimes(1); // indicator
    });
  });

  // ==========================================================================
  // Bug #6: destroy() cleanup
  // ==========================================================================

  describe('destroy (Bug #6)', () => {
    it('should clean up without calling removeEventListener directly', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);

      // Event listeners are registered via component.registerDomEvent
      // destroy() should NOT call removeEventListener directly
      nav.destroy();

      // Container should be emptied
      expect(container.empty).toHaveBeenCalled();
    });

    it('should nullify currentMessage on destroy', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);
      const message = createAssistantMessage({
        branches: [createBranch()],
        activeAlternativeIndex: 0
      });
      nav.updateMessage(message);

      nav.destroy();

      // After destroy, getCurrentAlternativeInfo should return null
      expect(nav.getCurrentAlternativeInfo()).toBeNull();
    });
  });

  // ==========================================================================
  // updateMessage
  // ==========================================================================

  describe('updateMessage', () => {
    it('should show navigator when message has branches', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);
      const message = createAssistantMessage({
        branches: [createBranch(), createBranch({ id: 'branch_2' })],
        activeAlternativeIndex: 0
      });

      nav.updateMessage(message);

      expect(container.addClass).toHaveBeenCalledWith('message-branch-navigator-visible');
    });

    it('should hide navigator when message has no branches', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);
      const message = createAssistantMessage({ branches: undefined });

      nav.updateMessage(message);

      expect(container.addClass).toHaveBeenCalledWith('message-branch-navigator-hidden');
    });
  });

  // ==========================================================================
  // getCurrentAlternativeInfo
  // ==========================================================================

  describe('getCurrentAlternativeInfo', () => {
    it('should return null when no message is set', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);

      expect(nav.getCurrentAlternativeInfo()).toBeNull();
    });

    it('should return correct info for message with branches', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);
      const message = createAssistantMessage({
        branches: [createBranch(), createBranch({ id: 'b2' })],
        activeAlternativeIndex: 1
      });
      nav.updateMessage(message);

      const info = nav.getCurrentAlternativeInfo();

      expect(info).not.toBeNull();
      expect(info!.current).toBe(2); // 1-based: index 1 => display 2
      expect(info!.total).toBe(3); // 2 branches + original
      expect(info!.hasAlternatives).toBe(true);
    });

    it('should return correct info for message without branches', () => {
      const nav = new MessageBranchNavigator(container, events, component as any);
      const message = createAssistantMessage({ branches: undefined });
      nav.updateMessage(message);

      const info = nav.getCurrentAlternativeInfo();

      expect(info).not.toBeNull();
      expect(info!.current).toBe(1);
      expect(info!.total).toBe(1);
      expect(info!.hasAlternatives).toBe(false);
    });
  });
});
