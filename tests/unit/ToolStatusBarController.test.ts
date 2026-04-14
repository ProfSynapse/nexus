/**
 * ToolStatusBarController unit tests
 *
 * After the ToolCallStateManager migration, the controller is a thin
 * pass-through: it receives pre-formatted ToolStatusEntry objects via
 * pushStatus() and forwards them to the ToolStatusBar after filtering
 * by the current streaming message ID.
 *
 * Plan-critical coverage:
 *   1. Non-terminal entries from a NON-current messageId are dropped (subagent filter)
 *   2. Terminal entries (past/failed) pass through even when messageId mismatches
 *   3. Entries pass through when streamingController returns null (early streaming phase)
 *   4. All entries reach the bar synchronously (no debounce coalescing)
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
  it('drops present-tense entries whose messageId does not match the current streaming message', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-current');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-subagent-branch', { text: 'Running Read', state: 'present' });

    expect(bar.pushStatus).not.toHaveBeenCalled();
    expect(streaming.getCurrentMessageId).toHaveBeenCalled();
  });

  it('forwards entries whose messageId matches the current streaming message', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-current');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-current', { text: 'Running Search Content', state: 'present' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    const entry = bar.pushStatus.mock.calls[0][0] as ToolStatusEntry;
    expect(entry.state).toBe('present');
    expect(entry.text).toBe('Running Search Content');
  });

  it('allows entries through when streamingController returns null (early streaming phase)', () => {
    const bar = makeBar();
    const streaming = makeStreaming(null);
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-any', { text: 'Running Read', state: 'present' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('allows past-tense entries through when streamingController returns null (post-finalize)', () => {
    const bar = makeBar();
    const streaming = makeStreaming(null);
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-any', { text: 'Ran Read', state: 'past' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    const entry = bar.pushStatus.mock.calls[0][0] as ToolStatusEntry;
    expect(entry.state).toBe('past');
  });

  it('allows past-tense entries through when messageId mismatches (post-finalize)', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-old');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-current', { text: 'Ran Read', state: 'past' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    expect((bar.pushStatus.mock.calls[0][0] as ToolStatusEntry).state).toBe('past');
  });

  it('allows failed entries through when messageId mismatches', () => {
    const bar = makeBar();
    const streaming = makeStreaming('msg-old');
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      streaming as unknown as StreamingController,
      component
    );

    controller.pushStatus('msg-current', { text: 'Failed to run Read', state: 'failed' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
    expect((bar.pushStatus.mock.calls[0][0] as ToolStatusEntry).state).toBe('failed');
  });
});

describe('ToolStatusBarController — batch entries (no debounce)', () => {
  it('pushes each entry synchronously to the status bar', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.pushStatus('m1', { text: 'Running Read', state: 'present' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('forwards all rapid-fire entries (no coalescing)', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.pushStatus('m1', { text: 'Running Read', state: 'present' });
    controller.pushStatus('m1', { text: 'Running Write', state: 'present' });
    controller.pushStatus('m1', { text: 'Running List', state: 'present' });

    expect(bar.pushStatus).toHaveBeenCalledTimes(3);
  });
});

describe('ToolStatusBarController — disposal via Component.register', () => {
  it('stops forwarding entries after the owning component unloads', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.pushStatus('m1', { text: 'Running Read', state: 'present' });
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    component.unload();

    controller.pushStatus('m1', { text: 'Running Write', state: 'present' });
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('drops entries after component unload (isDisposed guard)', () => {
    const bar = makeBar();
    const component = new Component();
    const controller = new ToolStatusBarController(
      bar as unknown as ToolStatusBar,
      makeStreaming('m1') as unknown as StreamingController,
      component
    );

    controller.pushStatus('m1', { text: 'Running Read', state: 'present' });
    expect(bar.pushStatus).toHaveBeenCalledTimes(1);

    component.unload();

    controller.pushStatus('m1', { text: 'Ran Read', state: 'past' });
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
