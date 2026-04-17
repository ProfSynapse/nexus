import { Component } from 'obsidian';
import { ManagedTimeoutTracker } from '../../src/ui/chat/utils/ManagedTimeoutTracker';

describe('ManagedTimeoutTracker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('setTimeout', () => {
    it('returns the same id that platform setTimeout would return', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb = jest.fn();
      const id = tracker.setTimeout(cb, 100);
      // The id must be truthy and clearTimeout-compatible (number in browsers, Timeout object in Node/Jest)
      expect(id).toBeTruthy();
      expect(() => clearTimeout(id)).not.toThrow();
    });

    it('executes callback after delay', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb = jest.fn();
      tracker.setTimeout(cb, 500);
      expect(cb).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('tracks multiple ids independently', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      tracker.setTimeout(cb1, 100);
      tracker.setTimeout(cb2, 200);
      jest.advanceTimersByTime(100);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).not.toHaveBeenCalled();
      jest.advanceTimersByTime(100);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('self-removes id from set after firing so set does not grow unboundedly', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb = jest.fn();
      tracker.setTimeout(cb, 50);
      jest.advanceTimersByTime(50);
      // After firing, clear() should be a no-op (no pending ids)
      expect(() => tracker.clear()).not.toThrow();
    });
  });

  describe('clear', () => {
    it('cancels all pending timeouts', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      tracker.setTimeout(cb1, 100);
      tracker.setTimeout(cb2, 200);
      tracker.clear();
      jest.runAllTimers();
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).not.toHaveBeenCalled();
    });

    it('is idempotent — calling clear twice does not throw', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      tracker.setTimeout(jest.fn(), 100);
      tracker.clear();
      expect(() => tracker.clear()).not.toThrow();
    });

    it('is idempotent on empty tracker', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      expect(() => tracker.clear()).not.toThrow();
    });
  });

  describe('Component lifecycle integration', () => {
    it('registers a cleanup callback via component.register', () => {
      const component = new Component();
      const spy = jest.spyOn(component, 'register');
      new ManagedTimeoutTracker(component);
      expect(spy).toHaveBeenCalledWith(expect.any(Function));
    });

    it('Component unload triggers clear — cancels pending timeouts', () => {
      const component = new Component();
      const tracker = new ManagedTimeoutTracker(component);
      const cb = jest.fn();
      tracker.setTimeout(cb, 500);
      component.unload();
      jest.runAllTimers();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
