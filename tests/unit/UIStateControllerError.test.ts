/**
 * #429: the chat error used to vanish after five seconds, too soon to read a
 * provider's quota message on a phone. It now stays until dismissed or until
 * the next turn starts, and only the latest error is shown.
 */
import { Component } from 'obsidian';
import { UIStateController } from '../../src/ui/chat/controllers/UIStateController';

/** Just enough DOM for showError: a container that tracks its .chat-error children. */
interface FakeEl {
  cls: string;
  text?: string;
  attr?: Record<string, string>;
  children: FakeEl[];
  parent?: FakeEl;
  listeners: Record<string, () => void>;
  createDiv(opts: { cls: string; attr?: Record<string, string> }): FakeEl;
  createSpan(opts: { cls: string; text: string }): FakeEl;
  createEl(tag: string, opts: { cls: string; attr?: Record<string, string> }): FakeEl;
  addEventListener(type: string, handler: () => void): void;
  remove(): void;
}

function fakeEl(cls = '', parent?: FakeEl): FakeEl {
  const el: FakeEl = {
    cls, parent, children: [], listeners: {},
    createDiv: opts => child(opts.cls, { attr: opts.attr }),
    createSpan: opts => child(opts.cls, { text: opts.text }),
    createEl: (_tag, opts) => child(opts.cls, { attr: opts.attr }),
    addEventListener: (type, handler) => { el.listeners[type] = handler; },
    remove: () => { if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el); },
  };
  function child(childCls: string, extra: Partial<FakeEl>): FakeEl {
    const c = Object.assign(fakeEl(childCls, el), extra);
    el.children.push(c);
    return c;
  }
  return el;
}

function setup() {
  const display = fakeEl('message-display-container');
  const errors = () => display.children.filter(c => c.cls === 'chat-error');
  const containerEl = {
    querySelector: (selector: string) => selector === '.message-display-container' ? display : null,
    querySelectorAll: (selector: string) => selector === '.chat-error' ? errors() : [],
  } as unknown as HTMLElement;
  const controller = new UIStateController(containerEl, { onSidebarToggled: jest.fn() }, new Component());
  const textOf = (error: FakeEl) => error.children.find(c => c.cls === 'chat-error-text')?.text;
  const dismissOf = (error: FakeEl) => error.children.find(c => c.cls.includes('chat-error-dismiss'));
  return { controller, errors, textOf, dismissOf };
}

describe('UIStateController.showError', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps the error on screen well past the old five-second dismissal', () => {
    jest.useFakeTimers();
    const { controller, errors, textOf } = setup();

    controller.showError('Google AI is overloaded right now. (HTTP 503)');
    jest.advanceTimersByTime(60_000);

    expect(errors()).toHaveLength(1);
    expect(textOf(errors()[0])).toBe('Google AI is overloaded right now. (HTTP 503)');
    expect(errors()[0].attr).toEqual({ role: 'alert' });
  });

  it('removes the error when the dismiss button is clicked', () => {
    const { controller, errors, dismissOf } = setup();
    controller.showError('boom');

    const dismiss = dismissOf(errors()[0]);
    expect(dismiss?.attr?.['aria-label']).toBe('Dismiss error');
    dismiss?.listeners.click();

    expect(errors()).toHaveLength(0);
  });

  it('shows only the latest error, and clearError removes it', () => {
    const { controller, errors, textOf } = setup();
    controller.showError('first');
    controller.showError('second');

    expect(errors().map(textOf)).toEqual(['second']);
    controller.clearError();
    expect(errors()).toHaveLength(0);
  });
});
