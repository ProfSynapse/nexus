/**
 * ContentEditableSuggester: which document the dropdown and its click-outside
 * listener belong to.
 *
 * Suggesters are built with the chat view. When a chat view is restored into a
 * popout, it loads while the main window has focus, so window.activeDocument at
 * construction is the main document, not the popout the input lives in. Bound
 * there, the click-outside listener never hears clicks in the popout and the
 * dropdown cannot be dismissed by clicking away; destroy() then removed the
 * listener from whatever window had focus at teardown, leaking the original.
 *
 * What is faked: two documents (the input's own, and a different focused one)
 * and a minimal input element. What is real: the whole suggester base class.
 */

import { App } from 'obsidian';
import { ContentEditableSuggester } from '../../src/ui/chat/components/suggesters/ContentEditableSuggester';
import type { SuggestionItem } from '../../src/ui/chat/components/suggesters/base/SuggesterInterfaces';

type Listener = (event: { target: unknown }) => void;

function makeDoc(name: string) {
  const listeners = new Set<Listener>();
  const containers: Array<{ classList: { add: jest.Mock; remove: jest.Mock } }> = [];
  return {
    name,
    listeners,
    containers,
    addEventListener: jest.fn((type: string, l: Listener) => { if (type === 'click') listeners.add(l); }),
    removeEventListener: jest.fn((type: string, l: Listener) => { if (type === 'click') listeners.delete(l); }),
    defaultView: { innerHeight: 500 },
    body: {
      createDiv: jest.fn(() => {
        const el = {
          classList: { add: jest.fn(), remove: jest.fn() },
          style: {} as Record<string, string>,
          empty: jest.fn(),
          remove: jest.fn(),
          contains: jest.fn(() => false),
          querySelectorAll: jest.fn(() => []),
          createDiv: jest.fn(() => ({ addClass: jest.fn(), addEventListener: jest.fn() }))
        };
        containers.push(el);
        return el;
      })
    }
  };
}

class TestSuggester extends ContentEditableSuggester<string> {
  getSuggestions(): SuggestionItem<string>[] {
    return [{ data: 'one', score: 1, displayText: 'one' }];
  }
  renderSuggestion(): void {
    // nothing to render in the test
  }
  selectSuggestion(): void {
    // nothing to select in the test
  }
  open(): Promise<void> {
    return (this as unknown as { loadSuggestions(q: string): Promise<void> }).loadSuggestions('o');
  }
}

describe('ContentEditableSuggester host document', () => {
  const testWindow = window as unknown as object;
  let descriptor: PropertyDescriptor | undefined;
  let ownDoc: ReturnType<typeof makeDoc>;
  let focusedDoc: ReturnType<typeof makeDoc>;
  let element: HTMLElement;

  beforeEach(() => {
    ownDoc = makeDoc('popout');
    focusedDoc = makeDoc('main');
    descriptor = Object.getOwnPropertyDescriptor(testWindow, 'activeDocument');
    // Focus is elsewhere while the suggester is built and torn down.
    Object.defineProperty(testWindow, 'activeDocument', { configurable: true, get: () => focusedDoc });
    element = {
      ownerDocument: ownDoc,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      getBoundingClientRect: () => ({ left: 10, top: 400, width: 300 }),
      focus: jest.fn()
    } as unknown as HTMLElement;
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(testWindow, 'activeDocument', descriptor);
  });

  function build(): TestSuggester {
    return new TestSuggester({} as App, element, { trigger: /@(\w*)$/, maxSuggestions: 10, cacheTTL: 0 });
  }

  it('listens for click-outside on the input\'s own document', () => {
    build();
    expect(ownDoc.listeners.size).toBe(1);
    expect(focusedDoc.addEventListener).not.toHaveBeenCalled();
  });

  it('puts the dropdown in the input\'s own document and sizes it to that window', async () => {
    const suggester = build();
    await suggester.open();

    expect(ownDoc.body.createDiv).toHaveBeenCalledWith('suggester-container');
    expect(focusedDoc.body.createDiv).not.toHaveBeenCalled();
    const container = ownDoc.containers[0] as unknown as { style: Record<string, string> };
    expect(container.style.bottom).toBe(`${500 - 400 + 4}px`);
  });

  it('destroy() removes the listener from the document it was added to', () => {
    const suggester = build();
    // Focus has moved on again by the time the view closes.
    const laterDoc = makeDoc('settings');
    Object.defineProperty(testWindow, 'activeDocument', { configurable: true, get: () => laterDoc });

    suggester.destroy();

    expect(ownDoc.listeners.size).toBe(0);
    expect(focusedDoc.listeners.size).toBe(0);
  });
});
