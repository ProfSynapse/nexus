/**
 * MessageBubble Unit Tests
 *
 * Characterization coverage for the MessageBubble refactor seam.
 * Verifies:
 * - active alternative data is passed through to the tool bubble render path
 * - branch navigator is created lazily when branches appear later and reused
 * - retry-style layout switches rebuild the DOM and clear accordion state
 */

import { App, createMockElement } from 'obsidian';
import { createAssistantMessage, createBranch, createCompletedToolCall } from '../fixtures/chatBugs';

const mockCreateToolBubble = jest.fn();
const mockCreateToolBubbleOnDemand = jest.fn();
const mockCreateTextBubble = jest.fn();
const mockRenderContent = jest.fn().mockResolvedValue(undefined);
const mockGetReferenceMetadata = jest.fn(() => ({ references: [] }));
const mockGetToolEventInfo = jest.fn();
const mockHandleEdit = jest.fn();
const mockAccordionInstances: Array<{
  createElement: jest.Mock;
  setDisplayGroup: jest.Mock;
  completeTool: jest.Mock;
  getDisplayGroup: jest.Mock;
  getElement: jest.Mock;
  cleanup: jest.Mock;
  setCallbacks: jest.Mock;
}> = [];
let mockNavigatorCache: {
  instance: {
    updateMessage: jest.Mock;
    destroy: jest.Mock;
  };
} | null = null;
const mockNavigatorInstances: Array<{
  updateMessage: jest.Mock;
  destroy: jest.Mock;
  setMessage?: jest.Mock;
}> = [];

jest.mock('../../src/ui/chat/components/factories/ToolBubbleFactory', () => ({
  ToolBubbleFactory: {
    createToolBubble: (...args: unknown[]) => mockCreateToolBubble(...args),
    createTextBubble: (...args: unknown[]) => mockCreateTextBubble(...args),
    createToolBubbleOnDemand: (...args: unknown[]) => mockCreateToolBubbleOnDemand(...args)
  }
}));

jest.mock('../../src/ui/chat/components/ProgressiveToolAccordion', () => ({
  ProgressiveToolAccordion: jest.fn().mockImplementation(() => {
    const element = createElement('div');
    element.addClass('progressive-tool-accordion');
    const instance = {
      createElement: jest.fn(() => element),
      setDisplayGroup: jest.fn(),
      completeTool: jest.fn(),
      getDisplayGroup: jest.fn(() => null),
      getElement: jest.fn(() => element),
      cleanup: jest.fn(),
      setCallbacks: jest.fn()
    };
    mockAccordionInstances.push(instance);
    return instance;
  })
}));

jest.mock('../../src/ui/chat/utils/ToolEventParser', () => ({
  ToolEventParser: {
    getToolEventInfo: (...args: unknown[]) => mockGetToolEventInfo(...args)
  }
}));

jest.mock('../../src/ui/chat/components/renderers/MessageContentRenderer', () => ({
  MessageContentRenderer: {
    renderContent: (...args: unknown[]) => mockRenderContent(...args)
  }
}));

jest.mock('../../src/ui/chat/components/renderers/ReferenceBadgeRenderer', () => ({
  ReferenceBadgeRenderer: {
    getReferenceMetadata: (...args: unknown[]) => mockGetReferenceMetadata(...args)
  }
}));

jest.mock('../../src/ui/chat/controllers/MessageEditController', () => ({
  MessageEditController: {
    handleEdit: (...args: unknown[]) => mockHandleEdit(...args)
  }
}));

jest.mock('../../src/ui/chat/components/MessageBranchNavigator', () => ({
  MessageBranchNavigator: jest.fn().mockImplementation((container: unknown, _events: unknown, _component: unknown) => {
    void container;
    if (mockNavigatorCache) {
      return mockNavigatorCache.instance;
    }

    const instance = {
      updateMessage: jest.fn(),
      destroy: jest.fn()
    };
    mockNavigatorCache = { instance };
    mockNavigatorInstances.push(instance);
    return instance;
  })
}));

import { MessageBubble } from '../../src/ui/chat/components/MessageBubble';
import { MessageBranchNavigator } from '../../src/ui/chat/components/MessageBranchNavigator';
import { ToolBubbleFactory } from '../../src/ui/chat/components/factories/ToolBubbleFactory';

type MockElement = HTMLElement & {
  children: MockElement[];
  parentElement: MockElement | null;
  replaceWith: jest.Mock<void, [MockElement]>;
  insertBefore: jest.Mock<void, [MockElement, MockElement | null?]>;
  appendText: jest.Mock<void, [string]>;
  querySelector: jest.Mock<MockElement | null, [string]>;
  querySelectorAll: jest.Mock<MockElement[], [string]>;
  addClass: jest.Mock<MockElement, [string]>;
  removeClass: jest.Mock<MockElement, [string]>;
  hasClass: jest.Mock<boolean, [string]>;
  empty: jest.Mock<void, []>;
  createEl: jest.Mock<MockElement, [string, { cls?: string; text?: string; attr?: Record<string, string> }?]>;
  createDiv: jest.Mock<MockElement, [string | { cls?: string; text?: string; attr?: Record<string, string> }?]>;
  createSpan: jest.Mock<MockElement, [{ cls?: string; text?: string; attr?: Record<string, string> }?]>;
  setAttribute: jest.Mock<void, [string, string]>;
  getAttribute: jest.Mock<string | null, [string]>;
  _classes: Set<string>;
  _attributes: Map<string, string>;
};

function matchesClassSelector(element: MockElement, selector: string): boolean {
  if (!selector.startsWith('.')) {
    return false;
  }

  return element._classes.has(selector.slice(1));
}

function findBySelector(element: MockElement, selector: string): MockElement | null {
  if (matchesClassSelector(element, selector)) {
    return element;
  }

  for (const child of element.children) {
    const match = findBySelector(child, selector);
    if (match) {
      return match;
    }
  }

  return null;
}

function createElement(tag = 'div'): MockElement {
  const element = createMockElement(tag) as MockElement;
  Object.setPrototypeOf(element, (globalThis as { HTMLElement: typeof HTMLElement }).HTMLElement.prototype);

  element.children = [];
  element.parentElement = null;
  element._classes = new Set<string>();
  element._attributes = new Map<string, string>();

  element.replaceWith = jest.fn((next: MockElement) => {
    void next;
  });
  element.insertBefore = jest.fn((child: MockElement, ref?: MockElement | null) => {
    void ref;
    child.parentElement = element;
    element.children.push(child);
    return child;
  });
  element.appendChild = jest.fn((child: MockElement) => {
    child.parentElement = element;
    element.children.push(child);
    return child;
  });
  element.appendText = jest.fn((text: string) => {
    element.textContent += text;
  });
  element.querySelector = jest.fn((selector: string) => findBySelector(element, selector));
  element.querySelectorAll = jest.fn(() => []);
  element.addClass = jest.fn((cls: string) => {
    cls.split(/\s+/).filter(Boolean).forEach(token => element._classes.add(token));
    return element;
  });
  element.removeClass = jest.fn((cls: string) => {
    cls.split(/\s+/).filter(Boolean).forEach(token => element._classes.delete(token));
    return element;
  });
  element.hasClass = jest.fn((cls: string) => element._classes.has(cls));
  element.empty = jest.fn(() => {
    element.children = [];
  });
  element.createEl = jest.fn((childTag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
    const child = createElement(childTag);
    if (opts?.cls) {
      child.addClass(opts.cls);
    }
    if (opts?.text) {
      child.textContent = opts.text;
    }
    if (opts?.attr) {
      Object.entries(opts.attr).forEach(([key, value]) => child.setAttribute(key, value));
    }
    child.parentElement = element;
    element.children.push(child);
    return child;
  });
  element.createDiv = jest.fn((clsOrOpts?: string | { cls?: string; text?: string; attr?: Record<string, string> }) => {
    const child = createElement('div');
    if (typeof clsOrOpts === 'string') {
      child.addClass(clsOrOpts);
    } else if (clsOrOpts?.cls) {
      child.addClass(clsOrOpts.cls);
    }
    if (typeof clsOrOpts !== 'string' && clsOrOpts?.text) {
      child.textContent = clsOrOpts.text;
    }
    if (typeof clsOrOpts !== 'string' && clsOrOpts?.attr) {
      Object.entries(clsOrOpts.attr).forEach(([key, value]) => child.setAttribute(key, value));
    }
    child.parentElement = element;
    element.children.push(child);
    return child;
  });
  element.createSpan = jest.fn((opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
    const child = createElement('span');
    if (opts?.cls) {
      child.addClass(opts.cls);
    }
    if (opts?.text) {
      child.textContent = opts.text;
    }
    if (opts?.attr) {
      Object.entries(opts.attr).forEach(([key, value]) => child.setAttribute(key, value));
    }
    child.parentElement = element;
    element.children.push(child);
    return child;
  });
  element.setAttribute = jest.fn((key: string, value: string) => {
    element._attributes.set(key, value);
  });
  element.getAttribute = jest.fn((key: string) => element._attributes.get(key) ?? null);

  return element;
}

function createBubbleShell(): MockElement {
  const bubble = createElement('div');
  bubble.addClass('message-container');

  const wrapper = bubble.createDiv('message-bubble');
  wrapper.createDiv('message-actions-external');
  wrapper.createDiv('message-content');

  return bubble;
}

function createToolBubbleShell(): MockElement {
  const bubble = createElement('div');
  bubble.addClass('message-container');
  bubble.addClass('message-tool');

  const wrapper = bubble.createDiv('message-bubble');
  wrapper.createDiv('tool-bubble-content');

  return bubble;
}

describe('MessageBubble', () => {
  let originalDocument: typeof globalThis.document | undefined;
  let originalHTMLElement: typeof globalThis.HTMLElement | undefined;
  let app: App;
  let activeBubble: MessageBubble | null = null;

  beforeAll(() => {
    originalDocument = globalThis.document;
    originalHTMLElement = globalThis.HTMLElement;

    class MockHTMLElement {}

    (globalThis as { HTMLElement: typeof MockHTMLElement }).HTMLElement = MockHTMLElement;
    (globalThis as {
      document: {
        createElement: (tag: string) => MockElement;
      };
    }).document = {
      createElement: (tag: string) => createElement(tag)
    };
  });

  afterAll(() => {
    if (originalHTMLElement) {
      (globalThis as { HTMLElement: typeof originalHTMLElement }).HTMLElement = originalHTMLElement;
    }
    if (originalDocument) {
      (globalThis as { document: typeof originalDocument }).document = originalDocument;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigatorCache = null;
    mockNavigatorInstances.length = 0;
    mockAccordionInstances.length = 0;
    activeBubble = null;
    mockGetToolEventInfo.mockReset();
    app = new App();
    mockCreateToolBubbleOnDemand.mockImplementation((message: { id: string }, parentElement?: MockElement | null) => {
      const bubble = createToolBubbleShell();
      bubble.setAttribute('data-message-id', `${message.id}_tools`);
      if (parentElement) {
        parentElement.insertBefore(bubble, parentElement.firstChild ?? null);
      }
      return bubble;
    });
    (app as unknown as {
      vault: {
        adapter: {
          getResourcePath: jest.Mock<(path: string) => string>;
        };
      };
      workspace: {
        openLinkText: jest.Mock<(path: string, subpath: string, newLeaf: boolean) => void>;
      };
    }).vault = {
      adapter: {
        getResourcePath: jest.fn((path: string) => `resource://${path}`)
      }
    };
    (app as unknown as {
      workspace: {
        openLinkText: jest.Mock<(path: string, subpath: string, newLeaf: boolean) => void>;
      };
    }).workspace = {
      openLinkText: jest.fn()
    };
  });

  afterEach(() => {
    if (activeBubble) {
      activeBubble.cleanup();
      activeBubble = null;
    }
  });

  it('passes the active branch alternative through to the tool render path', () => {
    const activeBranchToolCall = createCompletedToolCall({ id: 'tc_branch_active' });
    const message = createAssistantMessage({
      content: 'Original response',
      reasoning: 'Original reasoning',
      toolCalls: [createCompletedToolCall({ id: 'tc_original' })],
      branches: [
        createBranch({
          messages: [
            createAssistantMessage({
              id: 'msg_branch_active',
              content: 'Branch response',
              reasoning: 'Branch reasoning',
              toolCalls: [activeBranchToolCall]
            })
          ]
        })
      ],
      activeAlternativeIndex: 1
    });

    mockCreateToolBubble.mockImplementation(({ message: renderMessage }: { message: typeof message }) => {
      const shell = createElement('div');
      shell.createDiv('tool-bubble-content');
      expect(renderMessage.toolCalls).toEqual([activeBranchToolCall]);
      expect(renderMessage.reasoning).toBe('Branch reasoning');
      return shell;
    });

    mockCreateTextBubble.mockImplementation(() => {
      const shell = createBubbleShell();
      return shell;
    });

    const bubble = new MessageBubble(
      message,
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    bubble.createElement();

    expect(mockCreateToolBubble).toHaveBeenCalledTimes(1);
    expect(mockCreateTextBubble).toHaveBeenCalledTimes(1);
  });

  it('renders source links from assistant metadata', async () => {
    const message = createAssistantMessage({
      id: 'msg_with_sources',
      toolCalls: undefined,
      metadata: {
        webSearchResults: [
          {
            title: 'Perplexity streaming docs',
            url: 'https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode',
            date: '2026-04-08'
          }
        ],
        citations: [
          'https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode',
          'https://docs.perplexity.ai/api-reference/chat-completions-post'
        ]
      }
    });

    mockCreateToolBubble.mockImplementation(() => {
      const shell = createElement('div');
      shell.createDiv('tool-bubble-content');
      return shell;
    });
    mockCreateTextBubble.mockImplementation(() => createBubbleShell());

    const bubble = new MessageBubble(
      message,
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    const element = bubble.createElement() as MockElement;
    await Promise.resolve();

    const content = element.querySelector('.message-content') as MockElement | null;
    expect(content).not.toBeNull();

    const sourcesFooter = content?.querySelector('.message-sources') as MockElement | null;
    expect(sourcesFooter).not.toBeNull();

    const sourceList = sourcesFooter?.querySelector('.message-source-list') as MockElement | null;
    expect(sourceList).not.toBeNull();
    expect(sourceList?.children).toHaveLength(2);
    expect(sourceList?.children[0]?.getAttribute('href')).toBe('https://docs.perplexity.ai/docs/sonar/pro-search/stream-mode');
    expect(sourceList?.children[0]?.textContent).toBe('Perplexity streaming docs');
    expect(sourceList?.children[1]?.textContent).toBe('docs.perplexity.ai');
  });

  it('creates the branch navigator lazily when branches appear later and reuses it on subsequent updates', () => {
    const initialMessage = createAssistantMessage({
      id: 'msg_ai_base',
      content: 'Base response',
      branches: undefined,
      activeAlternativeIndex: 0
    });

    mockCreateToolBubble.mockImplementation(() => {
      const shell = createElement('div');
      shell.createDiv('tool-bubble-content');
      return shell;
    });

    mockCreateTextBubble.mockImplementation(() => createBubbleShell());

    const bubble = new MessageBubble(
      initialMessage,
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    const root = bubble.createElement();
    expect(MessageBranchNavigator).not.toHaveBeenCalled();

    const firstBranchUpdate = createAssistantMessage({
      id: 'msg_ai_branch_1',
      content: 'Branch response',
      branches: [createBranch({ id: 'branch_a' })],
      activeAlternativeIndex: 1
    });

    bubble.updateWithNewMessage(firstBranchUpdate);

    expect(MessageBranchNavigator).toHaveBeenCalledTimes(1);
    expect(mockNavigatorInstances[0].updateMessage).toHaveBeenCalledTimes(1);
    expect(mockNavigatorInstances[0].updateMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 'msg_ai_branch_1',
        activeAlternativeIndex: 1
      })
    );
    expect(root.querySelector('.message-actions-external')).toBeDefined();

    const secondBranchUpdate = createAssistantMessage({
      id: 'msg_ai_branch_2',
      content: 'Second branch response',
      branches: [
        createBranch({ id: 'branch_a' }),
        createBranch({ id: 'branch_b' })
      ],
      activeAlternativeIndex: 2
    });

    bubble.updateWithNewMessage(secondBranchUpdate);

    expect(MessageBranchNavigator).toHaveBeenCalled();
    expect(mockNavigatorInstances).toHaveLength(1);
    expect(mockNavigatorInstances[0].updateMessage).toHaveBeenCalledTimes(2);
    expect(mockNavigatorInstances[0].updateMessage.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 'msg_ai_branch_1',
        activeAlternativeIndex: 1
      })
    );
    expect(mockNavigatorInstances[0].updateMessage.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        id: 'msg_ai_branch_2',
        activeAlternativeIndex: 2
      })
    );
  });

  it('rebuilds the bubble when retry-style state changes switch layouts and clears accordion state', () => {
    const initialMessage = createAssistantMessage({
      id: 'msg_ai_retry',
      content: 'Tool-backed response',
      toolCalls: [createCompletedToolCall({ id: 'tc_retry' })],
      activeAlternativeIndex: 0
    });

    mockCreateToolBubble.mockImplementation(() => {
      const shell = createElement('div');
      shell.createDiv('tool-bubble-content');
      return shell;
    });
    mockCreateTextBubble.mockImplementation(() => createBubbleShell());

    const bubble = new MessageBubble(
      initialMessage,
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    const originalElement = bubble.createElement();
    originalElement.parentElement = createElement('div');

    const accordionElement = createElement('div');
    const fakeAccordion = {
      getElement: jest.fn(() => accordionElement),
      cleanup: jest.fn()
    };
    bubble.getProgressiveToolAccordions().set('fake_tool', fakeAccordion as never);

    const createElementSpy = jest.spyOn(bubble, 'createElement');

    const retryMessage = createAssistantMessage({
      id: 'msg_ai_retry',
      content: '',
      toolCalls: undefined,
      isLoading: true,
      state: 'streaming'
    });

    bubble.updateWithNewMessage(retryMessage);

    expect(createElementSpy).toHaveBeenCalledTimes(1);
    expect(originalElement.replaceWith).toHaveBeenCalledTimes(1);
    expect(fakeAccordion.getElement).toHaveBeenCalledTimes(1);
    expect(accordionElement.remove).toHaveBeenCalledTimes(1);
    expect(fakeAccordion.cleanup).toHaveBeenCalledTimes(1);
    expect(mockCreateToolBubble).toHaveBeenCalledTimes(1);
    expect(mockCreateTextBubble).toHaveBeenCalledTimes(1);
    expect(bubble.getElement()).not.toBe(originalElement);
  });

  it('creates progressive accordions from streaming tool events and attaches them to an on-demand tool bubble', () => {
    const bubble = new MessageBubble(
      createAssistantMessage({
        id: 'msg_tool_stream',
        content: ''
      }),
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    const root = bubble.createElement();

    mockGetToolEventInfo.mockReturnValue({
      toolId: 'tool_stream_1',
      batchId: null,
      stepId: 'tool_stream_1',
      parentToolCallId: null,
      callIndex: undefined,
      totalCalls: undefined,
      strategy: undefined,
      isBatchStepEvent: false,
      displayName: 'Search vault',
      technicalName: 'searchVault',
      parameters: undefined,
      isComplete: false,
      displayGroup: { kind: 'batch', steps: [] },
      type: undefined,
      result: undefined,
      status: 'executing',
      isVirtual: undefined
    });

    bubble.handleToolEvent('detected', {
      toolCall: {
        id: 'tool_stream_1',
        name: 'Search vault',
        technicalName: 'searchVault'
      }
    } as never);

    expect(mockGetToolEventInfo).toHaveBeenCalledTimes(1);
    expect(mockAccordionInstances).toHaveLength(1);
    expect(mockAccordionInstances[0].createElement).toHaveBeenCalledTimes(1);
    expect(mockAccordionInstances[0].setCallbacks).toHaveBeenCalledWith(
      expect.objectContaining({
        onViewBranch: expect.any(Function)
      })
    );
    expect(mockAccordionInstances[0].setDisplayGroup).toHaveBeenCalledTimes(1);
    expect(bubble.getProgressiveToolAccordions().size).toBe(1);

    const toolBubble = root.querySelector('.message-tool');
    expect(toolBubble).toBeDefined();
  });

  it('renders generated images from completed tool results', () => {
    const bubble = new MessageBubble(
      createAssistantMessage({
        id: 'msg_image_result',
        content: ''
      }),
      app,
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn()
    );
    activeBubble = bubble;

    const root = bubble.createElement();

    mockGetToolEventInfo.mockReturnValue({
      toolId: 'tool_image_1',
      batchId: null,
      stepId: 'tool_image_1',
      parentToolCallId: null,
      callIndex: undefined,
      totalCalls: undefined,
      strategy: undefined,
      isBatchStepEvent: false,
      displayName: 'Generate image',
      technicalName: 'generateImage',
      parameters: undefined,
      isComplete: true,
      displayGroup: { kind: 'batch', steps: [] },
      type: undefined,
      result: {
        data: {
          imagePath: 'images/generated.png',
          prompt: 'A black cat in a window'
        }
      },
      status: 'completed',
      isVirtual: undefined
    });

    bubble.handleToolEvent('completed', {
      toolCall: {
        id: 'tool_image_1',
        name: 'Generate image',
        technicalName: 'generateImage'
      },
      result: {
        data: {
          imagePath: 'images/generated.png',
          prompt: 'A black cat in a window'
        }
      },
      success: true
    } as never);

    expect(mockGetToolEventInfo).toHaveBeenCalledTimes(1);
    expect(mockAccordionInstances).toHaveLength(1);
    expect(mockAccordionInstances[0].setDisplayGroup).toHaveBeenCalledTimes(1);
    expect(mockAccordionInstances[0].completeTool).not.toHaveBeenCalled();

    const imageBubble = root.querySelector('.message-image');
    expect(imageBubble).toBeDefined();

    const image = imageBubble?.querySelector('.generated-image') as MockElement | null;
    expect(image).toBeDefined();
    expect((image as unknown as { src?: string }).src).toBe('resource://images/generated.png');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect((image as unknown as { alt?: string }).alt).toBe('A black cat in a window');

    const openButton = imageBubble?.querySelector('.generated-image-open-btn');
    expect(openButton).toBeDefined();
    expect((app.vault.adapter.getResourcePath as jest.Mock).mock.calls).toEqual([
      ['images/generated.png']
    ]);
  });
});
