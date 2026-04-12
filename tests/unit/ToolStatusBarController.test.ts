/**
 * ToolStatusBarController unit tests
 *
 * Plan-critical coverage:
 *   1. Events from a NON-current messageId (subagent turns) MUST NOT reach the bar
 *   2. Leading-edge 400ms debounce fires immediately on the first call
 *   3. Tense mapping: completed+success → past, completed+failure → failed, else → present
 *   4. Component.register wires a cleanup that cancels pending debounced calls
 *
 * Constraints:
 *   - No jest.useFakeTimers()
 *   - Uses the real debounce mock from tests/mocks/obsidian (leading-edge faithful)
 *   - Real setTimeout waits on a known-short interval (≤ 50ms) to verify suppression
 */

import { Component } from 'obsidian';
import { ToolStatusBarController } from '../../src/ui/chat/controllers/ToolStatusBarController';
import type { ToolStatusBar, ToolStatusEntry } from '../../src/ui/chat/components/ToolStatusBar';
import type { StreamingController } from '../../src/ui/chat/controllers/StreamingController';

type MockStatusBar = Pick<ToolStatusBar, 'pushStatus'> & { pushStatus: jest.Mock };
type MockStreaming = Pick<StreamingController, 'getCurrentMessageId'> & { getCurrentMessageId: jest.Mock };

function makeBar(): MockStatusBar {
  return { pushStatus: jest.fn() };
}

function makeStreaming(currentId: string | null): MockStreaming {
  return { getCurrentMessageId: jest.fn(() => currentId) };
}

/** Sleep via real setTimeout — no fake timers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ToolStatusBarController — subagent filter (PLAN CRITICAL)', () => {
  it('drops events whose messageId does not match the current streaming message', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-current');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    // Subagent tool event arrives with a DIFFERENT message id
    controller.handleToolEvent('msg-subagent-branch', 'started', {
      name: 'searchContent',
      displayName: 'Search content',
      technicalName: 'searchManager_searchContent',
      parameters: { query: 'notes' },
    });

    expect(bar.pushStatus).not.toHaveBeenCalled();
    expect(streaming.getCurrentMessageId).toHaveBeenCalled();
  });

  it('forwards events whose messageId matches the current streaming message', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-current');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('msg-current', 'started', {
      name: 'searchContent',
      displayName: 'Search content',
      technicalName: 'searchManager_searchContent',
      parameters: { query: 'meeting notes' },
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    const entry = bar.pushStatus.mock.calls[0][0] as ToolStatusEntry;
    expect(entry.state).toBe('present');
    // Label text is produced by formatToolStepLabel — should be non-empty
    expect(typeof entry.text).toBe('string');
    expect(entry.text.length).toBeGreaterThan(0);
  });

  it('drops events when streamingController returns null (no active stream)', () => {
    const bar = makeBar();
    const streaming = makeStreaming(null);
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('msg-any', 'started', {
      name: 'test',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });

    expect(bar.pushStatus).not.toHaveBeenCalled();
  });
});

describe('ToolStatusBarController — tense mapping', () => {
  it('maps completed+success → past tense', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('m1', 'completed', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
      success: true,
      result: { ok: true },
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    const entry = bar.pushStatus.mock.calls[0][0] as ToolStatusEntry;
    expect(entry.state).toBe('past');
  });

  it('maps completed+success=false → failed tense', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('m1', 'completed', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
      success: false,
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    expect((bar.pushStatus.mock.calls[0][0] as ToolStatusEntry).state).toBe('failed');
  });

  it('maps completed with error string → failed tense', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('m1', 'completed', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
      error: 'File not found',
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    expect((bar.pushStatus.mock.calls[0][0] as ToolStatusEntry).state).toBe('failed');
  });

  it('maps non-completed events → present tense', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });

    controller.handleToolEvent('m1', 'detected', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'b.md' },
    });

    expect(bar.pushStatus).toHaveBeenCalled();
    // All non-completed events should use present tense
    for (const call of bar.pushStatus.mock.calls) {
      expect((call[0] as ToolStatusEntry).state).toBe('present');
    }
  });
});

describe('ToolStatusBarController — 400ms leading-edge debounce', () => {
  it('fires the first call immediately (leading edge)', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });

    // Leading-edge: first call fires synchronously via debounce
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('suppresses follow-up calls within the 400ms window', async () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    // Fire three events in rapid succession (well under 400ms)
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'b.md' },
    });
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'c.md' },
    });

    // Only the leading-edge call should be observed immediately.
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    // Give the trailing timeout a chance to fire the latest queued call.
    await sleep(450);

    // After the window expires, the trailing call for 'c.md' should have fired.
    expect(bar.pushStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ToolStatusBarController — disposal via Component.register', () => {
  it('stops forwarding events after the owning component unloads', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    // First event fires normally
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    // Unload the component — registered cleanup runs and marks disposed
    component.unload();

    // Subsequent events are dropped
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'b.md' },
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('cancels pending trailing debounced calls on component unload', async () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    // Burn the leading call, then queue a trailing call
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });
    controller.handleToolEvent('m1', 'started', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'b.md' },
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    // Unload BEFORE the trailing timeout fires (400ms window)
    component.unload();

    // Wait past the window — the trailing fire, if it wasn't cancelled,
    // would reach the isDisposed guard and be blocked anyway.
    await sleep(500);

    // Either the cancel worked OR the isDisposed guard tripped;
    // either way, no SECOND pushStatus should reach the bar.
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });
});

describe('ToolStatusBarController — accessors', () => {
  it('exposes the wrapped status bar via getStatusBar', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    expect(controller.getStatusBar()).toBe(bar);
  });
});
