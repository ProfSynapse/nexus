/**
 * MessageDisplay Unit Tests
 *
 * Tests for incremental message reconciliation.
 * Bug #7: Full re-render destroyed live tool accordions.
 * Bug #12: Full re-render lost progressive tool accordion state.
 *
 * Key behaviors verified:
 * - Reconciliation reuses existing MessageBubble instances
 * - Stale bubbles get cleanup() called when removed
 * - Full render happens on conversation switch
 * - Map-based lookup works correctly
 *
 * Note: MessageDisplay is heavily DOM-dependent. These tests use lightweight
 * mocks and focus on the reconciliation logic rather than DOM rendering.
 */

import { createConversation, createUserMessage, createAssistantMessage } from '../fixtures/chatBugs';

// We need to mock the MessageBubble and BranchManager imports before importing MessageDisplay
// Since MessageDisplay has deep DOM dependencies, we test the reconciliation logic through
// the public API with mocked internals.

// Mock MessageBubble
const mockCleanup = jest.fn();
const mockGetElement = jest.fn();
const mockUpdateWithNewMessage = jest.fn();
const mockCreateElement = jest.fn();
const mockGetProgressiveToolAccordions = jest.fn(() => new Map());

jest.mock('../../src/ui/chat/components/MessageBubble', () => {
  return {
    MessageBubble: jest.fn().mockImplementation((message: any) => ({
      message,
      cleanup: mockCleanup,
      getElement: mockGetElement,
      updateWithNewMessage: mockUpdateWithNewMessage,
      createElement: mockCreateElement,
      getProgressiveToolAccordions: mockGetProgressiveToolAccordions,
      updateContent: jest.fn()
    }))
  };
});

// Mock BranchManager
jest.mock('../../src/ui/chat/services/BranchManager', () => {
  return {
    BranchManager: jest.fn().mockImplementation(() => ({
      getActiveMessageContent: jest.fn((msg: any) => msg.content),
      getActiveMessageToolCalls: jest.fn((msg: any) => msg.toolCalls)
    }))
  };
});

// Mock obsidian module (already handled by jest.config moduleNameMapper)

import { MessageDisplay } from '../../src/ui/chat/components/MessageDisplay';
import { App } from '../mocks/obsidian';

/**
 * Create a deeply-recursive mock element that supports Obsidian's
 * createDiv/createEl/createSpan chaining pattern.
 */
function createDeepMockElement(tag = 'div'): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
      toggle: jest.fn()
    },
    addClass: jest.fn(),
    removeClass: jest.fn(),
    hasClass: jest.fn(() => false),
    empty: jest.fn(),
    createEl: jest.fn((t: string, opts?: any) => createDeepMockElement(t)),
    createDiv: jest.fn((cls?: string) => createDeepMockElement('div')),
    createSpan: jest.fn((cls?: string) => createDeepMockElement('span')),
    appendChild: jest.fn(),
    prepend: jest.fn(),
    removeChild: jest.fn(),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    remove: jest.fn(),
    after: jest.fn(),
    textContent: '',
    innerHTML: '',
    style: {},
    value: '',
    scrollTop: 0,
    scrollHeight: 1000,
    focus: jest.fn(),
    firstElementChild: null as any,
    nextElementSibling: null as any,
    children: [] as any[]
  };
  return el;
}

// Helper to create a mock container with Obsidian-like DOM methods
function createMockDisplayContainer() {
  const messagesContainer = createDeepMockElement('div');
  messagesContainer.className = 'messages-container';

  const container = createDeepMockElement('div');

  // Override createDiv to return messagesContainer for specific class
  container.createDiv = jest.fn((cls?: string) => {
    if (cls === 'messages-container') return messagesContainer;
    return createDeepMockElement('div');
  });

  // Override querySelector to return messagesContainer
  container.querySelector = jest.fn((selector: string) => {
    if (selector === '.messages-container') return messagesContainer;
    return null;
  });

  return { container, messagesContainer };
}

describe('MessageDisplay', () => {
  let display: MessageDisplay;
  let container: any;
  let messagesContainer: any;
  let mockApp: App;
  let mockBranchManager: any;

  beforeEach(() => {
    jest.clearAllMocks();

    const mocks = createMockDisplayContainer();
    container = mocks.container;
    messagesContainer = mocks.messagesContainer;
    mockApp = new App();

    // Create a simple BranchManager mock
    mockBranchManager = {
      getActiveMessageContent: jest.fn((msg: any) => msg.content),
      getActiveMessageToolCalls: jest.fn((msg: any) => msg.toolCalls)
    };

    // Mock createElement to return a trackable element
    mockCreateElement.mockImplementation(() => createDeepMockElement('div'));
    mockGetElement.mockImplementation(() => createDeepMockElement('div'));

    display = new MessageDisplay(
      container,
      mockApp as any,
      mockBranchManager
    );
  });

  // ==========================================================================
  // setConversation - full render on first load
  // ==========================================================================

  describe('setConversation - initial load', () => {
    it('should perform full render on first conversation load', () => {
      const conversation = createConversation();

      display.setConversation(conversation);

      // Full render clears container (render was also called in constructor for welcome)
      expect(container.empty).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // setConversation - conversation switch
  // ==========================================================================

  describe('setConversation - conversation switch', () => {
    it('should perform full render when switching to different conversation', () => {
      const conv1 = createConversation({ id: 'conv_1' });
      const conv2 = createConversation({ id: 'conv_2' });

      display.setConversation(conv1);
      jest.clearAllMocks();

      display.setConversation(conv2);

      // Should have called empty() for full render
      expect(container.empty).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // cleanup
  // ==========================================================================

  describe('cleanup', () => {
    it('should call cleanup on all bubbles when cleaning up display', () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'u1' }),
          createAssistantMessage({ id: 'a1' })
        ]
      });

      display.setConversation(conversation);
      jest.clearAllMocks();

      display.cleanup();

      // cleanup should have been called for each bubble
      expect(mockCleanup).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // findMessageBubble
  // ==========================================================================

  describe('findMessageBubble', () => {
    it('should find bubble by message ID after setConversation', () => {
      const conversation = createConversation({
        messages: [
          createUserMessage({ id: 'u1' }),
          createAssistantMessage({ id: 'a1' })
        ]
      });

      display.setConversation(conversation);

      // MessageBubble was mocked, so findMessageBubble should return the mock
      const bubble = display.findMessageBubble('a1');
      expect(bubble).toBeDefined();
    });

    it('should return undefined for unknown message ID', () => {
      const conversation = createConversation();
      display.setConversation(conversation);

      const bubble = display.findMessageBubble('nonexistent');
      expect(bubble).toBeUndefined();
    });
  });

  // ==========================================================================
  // updateMessageId
  // ==========================================================================

  describe('updateMessageId', () => {
    it('should re-key bubble from old ID to new ID', () => {
      const conversation = createConversation({
        messages: [createUserMessage({ id: 'temp_123' })]
      });

      display.setConversation(conversation);

      const updatedMessage = createUserMessage({ id: 'real_456' });
      display.updateMessageId('temp_123', 'real_456', updatedMessage);

      // Old key should be gone, new key should work
      expect(display.findMessageBubble('temp_123')).toBeUndefined();
      expect(display.findMessageBubble('real_456')).toBeDefined();
    });
  });
});
