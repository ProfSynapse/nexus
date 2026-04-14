/**
 * ToolStatusBarController unit tests
 *
 * Plan-critical coverage:
 *   1. Non-completed events from a NON-current messageId are dropped (subagent filter)
 *   2. Completed events pass through even when messageId is null/mismatched (post-finalize)
 *   3. Tense mapping: completed+success → past, completed+failure → failed, else → present
 *   4. All batch tool events reach the bar synchronously (no debounce coalescing)
 *   5. Component.register wires a cleanup that blocks all events after disposal
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

  it('drops non-completed events when streamingController returns null (no active stream)', () => {
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

  it('allows completed events through when streamingController returns null (post-finalize)', () => {
    const bar = makeBar();
    const streaming = makeStreaming(null);
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('msg-any', 'completed', {
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

  it('allows completed events through when messageId mismatches (post-finalize)', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-old');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.handleToolEvent('msg-current', 'completed', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
      success: true,
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    expect((bar.pushStatus.mock.calls[0][0] as ToolStatusEntry).state).toBe('past');
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

describe('ToolStatusBarController — batch tool events (no debounce)', () => {
  it('pushes each event synchronously to the status bar', () => {
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

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('forwards all rapid-fire events (no coalescing)', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    // Fire three events in rapid succession — all should reach the bar
    controller.handleToolEvent('m1', 'detected', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });
    controller.handleToolEvent('m1', 'detected', {
      name: 'write',
      technicalName: 'contentManager_write',
      parameters: { filePath: 'b.md' },
    });
    controller.handleToolEvent('m1', 'detected', {
      name: 'list',
      technicalName: 'storageManager_list',
      parameters: { folderPath: '/' },
    });

    expect(bar.pushStatus).toHaveBeenCalledTimes(3);
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

  it('drops completed events after component unload (isDisposed guard)', () => {
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
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    component.unload();

    // Even completed events should be blocked after disposal
    controller.handleToolEvent('m1', 'completed', {
      name: 'read',
      technicalName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
      success: true,
    });

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
