/**
 * ToolCallStateManager unit tests
 *
 * Covers:
 *   1. Forward-only transitions (detected → started → completed)
 *   2. Terminal states reject further transitions
 *   3. Same-phase metadata merge (enrichment without re-emission)
 *   4. State change listener fires on actual transitions
 *   5. clearMessage() cleanup
 *   6. clear() full reset
 *   7. Race scenario: started → detected (detected suppressed)
 *   8. getState() and getActiveToolCalls() accessors
 *   9. Multiple messages with isolated state
 *  10. Listener unsubscribe works
 */

import {
  ToolCallStateManager,
  type ToolCallPhase,
  type StateChangeEvent,
} from '../../src/ui/chat/services/ToolCallStateManager';

describe('ToolCallStateManager — forward-only transitions', () => {
  it('allows detected → started → completed', () => {
    const sm = new ToolCallStateManager();

    expect(sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' })).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('detected');

    expect(sm.transition('msg-1', 'tc-1', 'started')).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('started');

    expect(sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true })).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('completed');
  });

  it('allows detected → started → failed', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-1', 'tc-1', 'started');
    expect(sm.transition('msg-1', 'tc-1', 'failed', undefined, { error: 'timeout' })).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('failed');
    expect(sm.getState('tc-1')?.error).toBe('timeout');
  });

  it('allows skipping detected and going directly to started', () => {
    const sm = new ToolCallStateManager();

    expect(sm.transition('msg-1', 'tc-1', 'started', { rawName: 'read' })).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('started');
  });

  it('allows skipping detected+started and going directly to completed', () => {
    const sm = new ToolCallStateManager();

    expect(sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true })).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('completed');
  });
});

describe('ToolCallStateManager — regression rejection', () => {
  it('rejects started → detected', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'started', { rawName: 'read' });
    expect(sm.transition('msg-1', 'tc-1', 'detected')).toBe(false);
    expect(sm.getState('tc-1')?.phase).toBe('started');
  });

  it('rejects completed → started', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });
    expect(sm.transition('msg-1', 'tc-1', 'started')).toBe(false);
    expect(sm.getState('tc-1')?.phase).toBe('completed');
  });

  it('rejects completed → detected', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });
    expect(sm.transition('msg-1', 'tc-1', 'detected')).toBe(false);
  });

  it('rejects failed → started', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'failed', undefined, { error: 'oops' });
    expect(sm.transition('msg-1', 'tc-1', 'started')).toBe(false);
    expect(sm.getState('tc-1')?.phase).toBe('failed');
  });

  it('rejects failed → completed', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'failed', undefined, { error: 'oops' });
    expect(sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true })).toBe(false);
    expect(sm.getState('tc-1')?.phase).toBe('failed');
  });

  it('rejects completed → completed (same phase, same rank)', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });
    expect(sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true })).toBe(false);
  });
});

describe('ToolCallStateManager — same-phase metadata merge', () => {
  it('merges metadata on detected → detected without re-emitting', () => {
    const sm = new ToolCallStateManager();
    const listener = jest.fn();
    sm.onStateChange(listener);

    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' });
    expect(listener).toHaveBeenCalledTimes(1);

    // Same-phase update with additional metadata
    const merged = sm.transition('msg-1', 'tc-1', 'detected', { displayName: 'Read File' });
    expect(merged).toBe(false); // no state change event

    expect(listener).toHaveBeenCalledTimes(1); // listener NOT called again
    expect(sm.getState('tc-1')?.metadata.rawName).toBe('read');
    expect(sm.getState('tc-1')?.metadata.displayName).toBe('Read File');
  });

  it('does not merge metadata when no metadata is provided on same-phase', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' });
    sm.transition('msg-1', 'tc-1', 'detected'); // no metadata
    expect(sm.getState('tc-1')?.metadata.rawName).toBe('read');
  });
});

describe('ToolCallStateManager — state change listener', () => {
  it('fires on actual transitions', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' });
    sm.transition('msg-1', 'tc-1', 'started');
    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });

    expect(events).toHaveLength(3);
    expect(events[0].previousPhase).toBeNull();
    expect(events[0].newPhase).toBe('detected');
    expect(events[1].previousPhase).toBe('detected');
    expect(events[1].newPhase).toBe('started');
    expect(events[2].previousPhase).toBe('started');
    expect(events[2].newPhase).toBe('completed');
  });

  it('does NOT fire on rejected transitions', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('msg-1', 'tc-1', 'started', { rawName: 'read' });
    sm.transition('msg-1', 'tc-1', 'detected'); // rejected

    expect(events).toHaveLength(1);
    expect(events[0].newPhase).toBe('started');
  });

  it('includes correct messageId in events', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('msg-42', 'tc-1', 'detected');

    expect(events[0].messageId).toBe('msg-42');
    expect(events[0].toolCallId).toBe('tc-1');
  });

  it('includes state snapshot in events', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read', displayName: 'Read' });

    expect(events[0].state.metadata.rawName).toBe('read');
    expect(events[0].state.metadata.displayName).toBe('Read');
    expect(events[0].state.phase).toBe('detected');
  });
});

describe('ToolCallStateManager — listener unsubscribe', () => {
  it('stops receiving events after unsubscribe', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    const unsub = sm.onStateChange((e) => events.push(e));

    sm.transition('msg-1', 'tc-1', 'detected');
    expect(events).toHaveLength(1);

    unsub();

    sm.transition('msg-1', 'tc-1', 'started');
    expect(events).toHaveLength(1); // no new event
  });
});

describe('ToolCallStateManager — clearMessage()', () => {
  it('removes all entries for a message', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-1', 'tc-2', 'started');
    expect(sm.getState('tc-1')).toBeDefined();
    expect(sm.getState('tc-2')).toBeDefined();

    sm.clearMessage('msg-1');
    expect(sm.getState('tc-1')).toBeUndefined();
    expect(sm.getState('tc-2')).toBeUndefined();
  });

  it('does not affect entries for other messages', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-2', 'tc-2', 'started');

    sm.clearMessage('msg-1');
    expect(sm.getState('tc-1')).toBeUndefined();
    expect(sm.getState('tc-2')).toBeDefined();
  });

  it('is safe to call with a non-existent message ID', () => {
    const sm = new ToolCallStateManager();
    expect(() => sm.clearMessage('nonexistent')).not.toThrow();
  });

  it('prevents further transitions on cleared entries (new entry created)', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'started');
    sm.clearMessage('msg-1');

    // A new transition for the same toolCallId creates a fresh entry
    const result = sm.transition('msg-1', 'tc-1', 'detected');
    expect(result).toBe(true);
    expect(sm.getState('tc-1')?.phase).toBe('detected');
  });
});

describe('ToolCallStateManager — clear()', () => {
  it('removes all state and listeners', () => {
    const sm = new ToolCallStateManager();
    const listener = jest.fn();
    sm.onStateChange(listener);

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-2', 'tc-2', 'started');
    expect(listener).toHaveBeenCalledTimes(2);

    sm.clear();

    expect(sm.getState('tc-1')).toBeUndefined();
    expect(sm.getState('tc-2')).toBeUndefined();

    // Listeners are removed — new transitions don't fire old listener
    sm.transition('msg-3', 'tc-3', 'detected');
    expect(listener).toHaveBeenCalledTimes(2); // still 2
  });
});

describe('ToolCallStateManager — getActiveToolCalls()', () => {
  it('returns only non-terminal tool calls for a message', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-1', 'tc-2', 'started');
    sm.transition('msg-1', 'tc-3', 'completed', undefined, { success: true });
    sm.transition('msg-1', 'tc-4', 'failed', undefined, { error: 'err' });

    const active = sm.getActiveToolCalls('msg-1');
    expect(active).toHaveLength(2);
    expect(active.map(s => s.id).sort()).toEqual(['tc-1', 'tc-2']);
  });

  it('returns empty array for unknown message', () => {
    const sm = new ToolCallStateManager();
    expect(sm.getActiveToolCalls('nonexistent')).toEqual([]);
  });
});

describe('ToolCallStateManager — metadata preservation across phases', () => {
  it('preserves metadata from detected phase when transitioning to started', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected', {
      rawName: 'contentManager.read',
      displayName: 'Read',
      agentName: 'contentManager',
      actionName: 'Read',
      parameters: { filePath: 'notes.md' },
    });

    sm.transition('msg-1', 'tc-1', 'started');

    const state = sm.getState('tc-1')!;
    expect(state.metadata.rawName).toBe('contentManager.read');
    expect(state.metadata.displayName).toBe('Read');
    expect(state.metadata.parameters).toEqual({ filePath: 'notes.md' });
  });

  it('merges new metadata fields on phase advance', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' });
    sm.transition('msg-1', 'tc-1', 'started', { displayName: 'Read File' });

    const state = sm.getState('tc-1')!;
    expect(state.metadata.rawName).toBe('read');
    expect(state.metadata.displayName).toBe('Read File');
  });

  it('preserves result/error data from completion', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-1', 'tc-1', 'completed', undefined, {
      result: { data: 'file content' },
      success: true,
    });

    const state = sm.getState('tc-1')!;
    expect(state.result).toEqual({ data: 'file content' });
    expect(state.success).toBe(true);
  });
});

describe('ToolCallStateManager — race scenario simulation', () => {
  it('handles started → detected → completed correctly (detected suppressed)', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    // Execution fires started first
    sm.transition('msg-1', 'tc-1', 'started', { rawName: 'read' });
    // Streaming parser fires late detected
    sm.transition('msg-1', 'tc-1', 'detected', { rawName: 'read' });
    // Execution fires completed
    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });

    // Only started and completed should have emitted events
    expect(events).toHaveLength(2);
    expect(events[0].newPhase).toBe('started');
    expect(events[1].newPhase).toBe('completed');
  });

  it('handles rapid detected → completed (skipping started)', () => {
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    sm.transition('msg-1', 'tc-1', 'detected');
    sm.transition('msg-1', 'tc-1', 'completed', undefined, { success: true });

    expect(events).toHaveLength(2);
    expect(events[0].newPhase).toBe('detected');
    expect(events[1].newPhase).toBe('completed');
  });
});

describe('ToolCallStateManager — bidirectional prefix correlation', () => {
  it('correlates when execution ID (call_abc_0) arrives before detection ID (call_abc)', () => {
    // This exercises the `toolCallId.startsWith(id)` branch at line 95 —
    // the reverse direction from the integration test's detection-first path.
    const sm = new ToolCallStateManager();
    const events: StateChangeEvent[] = [];
    sm.onStateChange((e) => events.push(e));

    // Execution path registers the suffixed ID first
    sm.transition('msg-1', 'call_abc_0', 'started', { rawName: 'read' });
    expect(sm.getState('call_abc_0')?.phase).toBe('started');
    expect(events).toHaveLength(1);

    // Detection path arrives late with the base (un-suffixed) ID
    const result = sm.transition('msg-1', 'call_abc', 'detected', { displayName: 'Read File' });

    // Forward-only: detected is a regression from started — state unchanged
    expect(result).toBe(false);
    expect(sm.getState('call_abc_0')?.phase).toBe('started');
    // But the metadata merge DID run (detected = same rank as started? No — detected < started)
    // The key assertion: no duplicate entry created — both IDs share the same slot
    expect(sm.getState('call_abc')).toBeUndefined(); // no separate entry for the base ID
    expect(events).toHaveLength(1); // no extra listener call
  });

  it('correlates when execution ID arrives first and then completes via base ID', () => {
    const sm = new ToolCallStateManager();

    // Execution registers suffixed ID
    sm.transition('msg-1', 'call_xyz_0', 'started', { rawName: 'write' });

    // Detection arrives with base ID — correlates, regression suppressed
    sm.transition('msg-1', 'call_xyz', 'detected');

    // Completion fires with base ID — should advance the canonical (suffixed) entry
    const completed = sm.transition('msg-1', 'call_xyz', 'completed', undefined, { success: true });
    expect(completed).toBe(true);
    expect(sm.getState('call_xyz_0')?.phase).toBe('completed');
    expect(sm.getState('call_xyz')).toBeUndefined(); // still no separate entry
  });
});

describe('ToolCallStateManager — parentId tracking', () => {
  it('captures batchId as parentId from metadata', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-inner', 'detected', { batchId: 'batch-1' });

    expect(sm.getState('tc-inner')?.parentId).toBe('batch-1');
  });

  it('preserves parentId across phase transitions', () => {
    const sm = new ToolCallStateManager();

    sm.transition('msg-1', 'tc-inner', 'detected', { batchId: 'batch-1' });
    sm.transition('msg-1', 'tc-inner', 'started');
    sm.transition('msg-1', 'tc-inner', 'completed', undefined, { success: true });

    expect(sm.getState('tc-inner')?.parentId).toBe('batch-1');
  });
});
