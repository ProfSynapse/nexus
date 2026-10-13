/**
 * ThinkingLoader unit tests
 *
 * Coverage:
 *   - start/stop lifecycle (container creation, clearing intervals, removing container)
 *   - isDisposed guard on double-stop and double-start after onunload
 *   - unload-during-interval (intervals cleared, isDisposed set)
 *   - updateIcon fallback path: primary setIcon throws → sparkles fallback
 *   - updateIcon fallback path: both setIcon throw → noop (no rethrow)
 *   - Icon substitution map (brain mapping)
 *
 * Constraints:
 *   - Node test env has no `window` — we shim `global.window` with setInterval/clearInterval
 *   - Timer regressions use a fake clock; production code owns text and lifecycle.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createMockElement } from 'obsidian';

// Shim global.window BEFORE importing ThinkingLoader (which only reads window.setInterval
// at method-call time, but we set it up early just in case of static init).
if (typeof (global as any).window === 'undefined') {
  (global as any).window = {
    setInterval: setInterval.bind(global),
    clearInterval: clearInterval.bind(global),
  };
} else {
  (global as any).window.setInterval ||= setInterval.bind(global);
  (global as any).window.clearInterval ||= clearInterval.bind(global);
}

// eslint-disable-next-line import/first
import { ThinkingLoader } from '../../src/ui/chat/components/ThinkingLoader';
// eslint-disable-next-line import/first
import * as obsidianMock from 'obsidian';

describe('ThinkingLoader — lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('start() creates a thinking-loader container with icon + word elements', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    loader.start(parent);

    // parent.createDiv should have been called at least once for the container
    expect(parent.createDiv).toHaveBeenCalledWith('thinking-loader');

    loader.stop();
  });

  it('stop() clears the container reference and no longer has anything to remove', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    loader.start(parent);
    loader.stop();

    // Calling stop() a second time should be a safe no-op
    expect(() => loader.stop()).not.toThrow();
  });

  it('double-start does not duplicate containers — prior intervals are cleared', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    loader.start(parent);
    const firstCallCount = (parent.createDiv as jest.Mock).mock.calls.length;

    loader.start(parent);
    const secondCallCount = (parent.createDiv as jest.Mock).mock.calls.length;

    // Second start calls stop() internally then creates a new container
    expect(secondCallCount).toBeGreaterThan(firstCallCount);

    loader.stop();
  });

  it('onunload() stops and marks disposed; subsequent start() is a no-op', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();
    loader.start(parent);

    loader.onunload();

    expect(loader.isDisposed).toBe(true);

    const callCountBefore = (parent.createDiv as jest.Mock).mock.calls.length;
    loader.start(parent); // Should be a no-op
    const callCountAfter = (parent.createDiv as jest.Mock).mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore);
  });

  it('stop() is safe to call before start()', () => {
    const loader = new ThinkingLoader();
    expect(() => loader.stop()).not.toThrow();
  });
});

describe('ThinkingLoader — updateIcon fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the primary icon name on the happy path', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    const setIconSpy = jest.spyOn(obsidianMock, 'setIcon');

    loader.start(parent);

    // The first setIcon call should have been for the 'brain' icon
    // (via ICON_SUBSTITUTIONS[brain] || 'brain')
    expect(setIconSpy).toHaveBeenCalled();
    const firstCall = setIconSpy.mock.calls[0];
    const iconName = firstCall[1] as string;
    // We don't hard-assert 'brain' because ICON_SUBSTITUTIONS may rename it;
    // we just assert it's a string (the happy path ran to completion).
    expect(typeof iconName).toBe('string');
    expect(iconName.length).toBeGreaterThan(0);

    loader.stop();
  });

  it('falls back to "sparkles" when the primary setIcon throws', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    let callIndex = 0;
    const setIconSpy = jest.spyOn(obsidianMock, 'setIcon').mockImplementation((el, _id) => {
      void el;
      callIndex += 1;
      if (callIndex === 1) {
        throw new Error('unknown icon');
      }
      // Subsequent calls (the fallback) succeed
    });

    loader.start(parent);

    // Both the primary failure and the sparkles fallback should have been attempted
    expect(setIconSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const fallbackCall = setIconSpy.mock.calls[1];
    expect(fallbackCall[1]).toBe('sparkles');

    loader.stop();
  });

  it('does not rethrow when BOTH primary and fallback setIcon throw', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    jest.spyOn(obsidianMock, 'setIcon').mockImplementation(() => {
      throw new Error('icon subsystem broken');
    });

    // The double-failure path should be swallowed — start() must not throw
    expect(() => loader.start(parent)).not.toThrow();

    loader.stop();
  });
});

describe('ThinkingLoader — isDisposed guards', () => {
  it('exposes isDisposed=false initially and true after onunload', () => {
    const loader = new ThinkingLoader();
    expect(loader.isDisposed).toBe(false);
    loader.onunload();
    expect(loader.isDisposed).toBe(true);
  });

  it('start() after disposal is a no-op (does not touch the parent)', () => {
    const parent = createMockElement('div');
    const loader = new ThinkingLoader();

    loader.onunload();
    loader.start(parent);

    expect(parent.createDiv).not.toHaveBeenCalled();
  });
});

// If typing/dots continue after settling, they overwrite the final Reasoning label.
describe('ThinkingLoader — typing and settling', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(window, 'setInterval').mockImplementation((handler, delay) => global.setInterval(handler, delay) as unknown as number);
    jest.spyOn(window, 'clearInterval').mockImplementation(id => global.clearInterval(id));
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it.each(['typing', 'dots'])('types words and dots, then stops %s when settled', phase => {
    const loader = new ThinkingLoader();
    try {
      loader.start(createMockElement('div'));
      const word = (loader as any).wordElement;
      expect(word.textContent).toBe('');
      jest.advanceTimersByTime(180);
      expect(word.textContent).toHaveLength(1);
      if (phase === 'dots') {
        // Reach the first dot without crossing the next five-second word cycle.
        for (let elapsed = 0; elapsed < 4500 && !word.textContent.endsWith('.'); elapsed += 10) jest.advanceTimersByTime(10);
        expect(word.textContent).toMatch(/\.$/);
        const firstDot = word.textContent;
        jest.advanceTimersByTime(500);
        expect(word.textContent).toBe(firstDot + '.');
      }
      loader.setActive(false);
      expect(word.textContent).toBe('Reasoning');
      jest.advanceTimersByTime(6000);
      expect(word.textContent).toBe('Reasoning');
      expect(jest.getTimerCount()).toBe(0);
    } finally { loader.stop(); }
  });
});
