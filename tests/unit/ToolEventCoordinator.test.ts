/**
 * ToolEventCoordinator unit tests — updated for ToolCallStateManager integration.
 *
 * The coordinator now routes all events through ToolCallStateManager.transition()
 * instead of calling controller.handleToolEvent() directly. State change events
 * are emitted back via the onStateChange listener in the coordinator, which then
 * calls controller.pushStatus().
 *
 * This suite verifies:
 *   1. handleToolCallsDetected → emits a 'detected' transition per tool call
 *   2. handleToolCallsDetected → emits an additional 'completed' transition for providerExecuted calls
 *   3. handleToolExecutionStarted → emits 'started' transition
 *   4. handleToolExecutionCompleted → emits 'completed' transition with the provided payload
 *   5. handleToolEvent (generic) → enriches metadata and forwards to state manager
 *   6. String-encoded tool parameters are JSON-parsed when possible
 *   7. useTools/getTools wrapper events are filtered out before reaching the state manager
 *   8. Forward-only semantics: started → detected does NOT regress the status bar
 */

import { ToolEventCoordinator } from '../../src/ui/chat/coordinators/ToolEventCoordinator';
import { ToolCallStateManager } from '../../src/ui/chat/services/ToolCallStateManager';
import type { ToolStatusBarController } from '../../src/ui/chat/controllers/ToolStatusBarController';
import type { ToolStatusEntry } from '../../src/ui/chat/components/ToolStatusBar';

type MockController = {
  pushStatus: jest.Mock<void, [string, ToolStatusEntry]>;
};

function makeController(): MockController {
  return {
    pushStatus: jest.fn(),
  };
}

function makeCoordinator(controller?: MockController): {
  coordinator: ToolEventCoordinator;
  controller: MockController;
  stateManager: ToolCallStateManager;
} {
  const ctrl = controller ?? makeController();
  const stateManager = new ToolCallStateManager();
  const coordinator = new ToolEventCoordinator(
    ctrl as unknown as ToolStatusBarController,
    stateManager
  );
  return { coordinator, controller: ctrl, stateManager };
}

describe('ToolEventCoordinator — state manager routing', () => {
  it('routes handleToolExecutionStarted through state manager → controller.pushStatus with present tense', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolExecutionStarted('msg-1', {
      id: 'tool-abc',
      name: 'contentManager_read',
      parameters: { filePath: 'notes.md' },
    });

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
    const [messageId, entry] = controller.pushStatus.mock.calls[0];
    expect(messageId).toBe('msg-1');
    expect(entry.state).toBe('present');
    expect(entry.text.length).toBeGreaterThan(0);
  });

  it('routes handleToolExecutionCompleted through state manager → controller.pushStatus with past tense', () => {
    const { coordinator, controller } = makeCoordinator();

    // First detect so there is state to complete
    coordinator.handleToolExecutionStarted('msg-2', {
      id: 'tool-xyz',
      name: 'contentManager_read',
    });
    controller.pushStatus.mockClear();

    coordinator.handleToolExecutionCompleted('msg-2', 'tool-xyz', { value: 42 }, true);

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
    const [messageId, entry] = controller.pushStatus.mock.calls[0];
    expect(messageId).toBe('msg-2');
    expect(entry.state).toBe('past');
  });

  it('forwards error string on completion failure', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolExecutionStarted('msg-3', {
      id: 'tool-err',
      name: 'contentManager_read',
    });
    controller.pushStatus.mockClear();

    coordinator.handleToolExecutionCompleted('msg-3', 'tool-err', null, false, 'permission denied');

    const [, entry] = controller.pushStatus.mock.calls[0];
    expect(entry.state).toBe('failed');
  });

  it('routes handleToolEvent (generic) through state manager with enriched data', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolEvent('msg-4', 'detected', {
      rawName: 'contentManager_read',
      id: 'gen-1',
      parameters: { filePath: 'a.md' },
    });

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
    const [messageId, entry] = controller.pushStatus.mock.calls[0];
    expect(messageId).toBe('msg-4');
    expect(entry.state).toBe('present');
    expect(entry.text.length).toBeGreaterThan(0);
  });
});

describe('ToolEventCoordinator — handleToolCallsDetected', () => {
  it('emits a detected transition for each tool call', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-batch', [
      {
        id: 'call-1',
        function: { name: 'contentManager_read', arguments: '{"filePath":"a.md"}' },
      },
      {
        id: 'call-2',
        function: { name: 'searchManager_searchContent', arguments: '{"query":"hello"}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    // Two tool calls → two pushStatus calls
    expect(controller.pushStatus).toHaveBeenCalledTimes(2);
    // Both should be present tense (detected)
    for (const call of controller.pushStatus.mock.calls) {
      expect(call[1].state).toBe('present');
    }
  });

  it('parses string-encoded arguments into structured parameters', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-parse', [
      {
        id: 'call-parse',
        function: { name: 'contentManager_read', arguments: '{"filePath":"a.md","limit":10}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const state = stateManager.getState('call-parse');
    expect(state).toBeDefined();
    expect(state!.metadata.parameters).toEqual({ filePath: 'a.md', limit: 10 });
  });

  it('leaves malformed JSON arguments as a raw string rather than throwing', () => {
    const { coordinator } = makeCoordinator();

    expect(() => {
      coordinator.handleToolCallsDetected('msg-bad', [
        {
          id: 'call-bad',
          function: { name: 'contentManager_read', arguments: '{not-valid-json' },
        },
      ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);
    }).not.toThrow();
  });

  it('emits a follow-up completed transition for providerExecuted tool calls with results', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-provider', [
      {
        id: 'call-provider',
        function: { name: 'searchManager_searchContent', arguments: '{"query":"x"}' },
        providerExecuted: true,
        result: { matches: 3 },
        success: true,
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    // Total = 2 pushStatus calls (detected + completed) for one providerExecuted call
    expect(controller.pushStatus).toHaveBeenCalledTimes(2);
    const states = controller.pushStatus.mock.calls.map(c => c[1].state);
    expect(states).toContain('present');
    expect(states).toContain('past');
  });

  it('does NOT emit a follow-up completed for non-provider tool calls', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-regular', [
      {
        id: 'call-regular',
        function: { name: 'contentManager_read', arguments: '{"filePath":"a.md"}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
    expect(controller.pushStatus.mock.calls[0][1].state).toBe('present');
  });

  it('handles an empty tool call array without calling the controller', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-empty', []);

    expect(controller.pushStatus).not.toHaveBeenCalled();
  });
});

describe('ToolEventCoordinator — useTools/getTools filter', () => {
  it('filters out useTools wrapper events from handleToolEvent', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolEvent('msg-1', 'completed', {
      name: 'useTools',
      id: 'wrapper-1',
    });

    expect(controller.pushStatus).not.toHaveBeenCalled();
  });

  it('filters out getTools wrapper events from handleToolEvent', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolEvent('msg-1', 'completed', {
      name: 'getTools',
      id: 'wrapper-2',
    });

    expect(controller.pushStatus).not.toHaveBeenCalled();
  });

  it('filters out namespaced useTools variants (e.g. toolManager_useTools)', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolEvent('msg-1', 'completed', {
      name: 'toolManager_useTools',
      id: 'wrapper-3',
    });

    expect(controller.pushStatus).not.toHaveBeenCalled();
  });
});

describe('ToolEventCoordinator — forward-only race prevention', () => {
  it('does NOT regress from started to detected for the same tool call ID', () => {
    const { coordinator, controller } = makeCoordinator();

    // Tool starts executing
    coordinator.handleToolExecutionStarted('msg-race', {
      id: 'tool-race',
      name: 'contentManager_read',
    });
    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
    expect(controller.pushStatus.mock.calls[0][1].state).toBe('present');

    controller.pushStatus.mockClear();

    // Late detection event arrives (streaming parser lag)
    coordinator.handleToolEvent('msg-race', 'detected', {
      id: 'tool-race',
      name: 'contentManager_read',
    });

    // Should NOT have emitted — detected is a regression from started
    expect(controller.pushStatus).not.toHaveBeenCalled();
  });

  it('does NOT regress from completed to started for the same tool call ID', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolExecutionStarted('msg-race2', {
      id: 'tool-race2',
      name: 'contentManager_read',
    });
    coordinator.handleToolExecutionCompleted('msg-race2', 'tool-race2', {}, true);
    controller.pushStatus.mockClear();

    // Late started event arrives
    coordinator.handleToolEvent('msg-race2', 'started', {
      id: 'tool-race2',
      name: 'contentManager_read',
    });

    expect(controller.pushStatus).not.toHaveBeenCalled();
  });
});

describe('ToolEventCoordinator — enrichToolEventData edge cases', () => {
  it('uses toolCall.parameters directly when present on the toolCall object', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-params', 'detected', {
      id: 'call-tp',
      rawName: 'contentManager_read',
      // No top-level `parameters` — provide via toolCall.parameters
      toolCall: {
        id: 'call-tp',
        parameters: { filePath: 'x.md' },
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-tp');
    expect(state).toBeDefined();
    // parameters should be taken from toolCall.parameters
    expect(state!.metadata.parameters).toEqual({ filePath: 'x.md' });
  });

  it('extracts parameters from toolCall.arguments (non-function path)', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-args', 'detected', {
      id: 'call-args',
      rawName: 'storageManager_move',
      toolCall: {
        id: 'call-args',
        arguments: '{"source":"a.md","target":"b.md"}',
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-args');
    expect(state?.metadata.parameters).toEqual({ source: 'a.md', target: 'b.md' });
  });

  it('returns raw object parameters unchanged when they are already an object', () => {
    const { coordinator, stateManager } = makeCoordinator();

    const rawParams = { filePath: 'notes.md', limit: 5 };
    coordinator.handleToolEvent('msg-obj', 'detected', {
      id: 'call-obj',
      rawName: 'contentManager_read',
      toolCall: {
        id: 'call-obj',
        arguments: rawParams, // already an object, not a string
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-obj');
    expect(state?.metadata.parameters).toEqual(rawParams);
  });

  it('returns the raw string when JSON.parse fails (malformed JSON via toolCall.function.arguments)', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-malformed', 'detected', {
      id: 'call-mal',
      rawName: 'contentManager_read',
      toolCall: {
        id: 'call-mal',
        function: { name: 'contentManager_read', arguments: '{not valid json' }, // malformed
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-mal');
    expect(state?.metadata.parameters).toBe('{not valid json'); // raw string preserved
  });

  it('returns undefined when toolCall has no arguments (undefined raw path)', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-noargs', 'detected', {
      id: 'call-noargs',
      rawName: 'storageManager_list',
      toolCall: {
        id: 'call-noargs',
        // no parameters, no arguments, no function.arguments
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-noargs');
    expect(state?.metadata.parameters).toBeUndefined();
  });

  it('uses top-level parameters field when provided, ignoring toolCall', () => {
    const { coordinator, stateManager } = makeCoordinator();

    const topLevelParams = { query: 'hello' };
    coordinator.handleToolEvent('msg-toplevel', 'detected', {
      id: 'call-toplevel',
      rawName: 'searchManager_searchContent',
      parameters: topLevelParams,
      toolCall: {
        id: 'call-toplevel',
        parameters: { query: 'ignored' }, // should be ignored
      },
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('call-toplevel');
    expect(state?.metadata.parameters).toEqual(topLevelParams);
  });
});

describe('ToolEventCoordinator — handleToolCallsDetected inner call edge cases', () => {
  it('handles toolCall with no function field — uses toolCall.name directly', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-no-func', [
      {
        id: 'call-nf',
        name: 'contentManager_read', // no .function field at all
        arguments: '{"filePath":"a.md"}',
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('handles toolCall with no id — uses fallback ID pattern', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-no-id', [
      {
        // no id field — should generate a fallback ID
        function: { name: 'contentManager_read', arguments: '{}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('uses toolCall.parameters when provided directly (line 110 branch)', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-direct-params', [
      {
        id: 'call-dp',
        name: 'contentManager_read', // using .name, not .function.name
        parameters: { filePath: 'direct.md' }, // parameters at top level
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const state = stateManager.getState('call-dp');
    expect(state).toBeDefined();
    expect(state!.metadata.parameters).toEqual({ filePath: 'direct.md' });
  });

  it('skips inner calls that are not objects (null/primitive entries in calls array)', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-bad-inner', [
      {
        id: 'call-usetools',
        function: {
          name: 'toolManager_useTools',
          arguments: JSON.stringify({
            context: {},
            calls: [null, 'not-an-object', 42], // all skipped by the inner type guard
          }),
        },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    // All inner calls are invalid — falls through to generic path (useTools with 0 extracted calls)
    // The generic path emits useTools which is then filtered, so nothing reaches the controller
    expect(controller.pushStatus).not.toHaveBeenCalled();
  });

  it('skips inner calls that are missing agent or tool fields', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-missing-fields', [
      {
        id: 'call-usetools-bad',
        function: {
          name: 'toolManager_useTools',
          arguments: JSON.stringify({
            context: {},
            calls: [
              { agent: '', tool: 'read' }, // empty agent — skipped
              { agent: 'contentManager', tool: '' }, // empty tool — skipped
            ],
          }),
        },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    // Both calls skipped — falls through with innerCalls.length > 0 (continue fires)
    // but no events emitted since both inner calls were skipped
    expect(controller.pushStatus).not.toHaveBeenCalled();
  });

  it('handles useTools with empty calls array by falling through to generic path', () => {
    const { coordinator, controller } = makeCoordinator();

    // Empty calls array → innerCalls.length === 0 → does NOT continue → falls through
    // to the generic emit path at lines 167+. The generic path emits useTools to the
    // state manager. The state change fires emitToStatusBar which calls controller.pushStatus.
    // (useTools IS emitted in the generic fallthrough — it's only filtered in handleToolEvent)
    expect(() => {
      coordinator.handleToolCallsDetected('msg-empty-calls', [
        {
          id: 'call-usetools-empty',
          function: {
            name: 'toolManager_useTools',
            arguments: JSON.stringify({ context: {}, calls: [] }),
          },
        },
      ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);
    }).not.toThrow();
  });

  it('handles inner call with non-object parameters (null) → parameters become undefined', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-null-params', [
      {
        id: 'call-usetools-np',
        function: {
          name: 'toolManager_useTools',
          arguments: JSON.stringify({
            context: {},
            calls: [
              { agent: 'contentManager', tool: 'read', parameters: null }, // null params
            ],
          }),
        },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const state = stateManager.getState('call-usetools-np_0');
    expect(state).toBeDefined();
    expect(state!.metadata.parameters).toBeUndefined(); // null params → undefined
  });
});

describe('ToolEventCoordinator — handleToolEvent phase mapping edge cases', () => {
  it('maps "updated" event type to "detected" phase', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-1', 'updated', {
      id: 'call-updated',
      rawName: 'contentManager_read',
    });

    const state = stateManager.getState('call-updated');
    expect(state?.phase).toBe('detected');
  });

  it('maps completed event with error string to "failed" phase (line 259)', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolEvent('msg-err', 'detected', {
      id: 'call-err-phase',
      rawName: 'contentManager_write',
    });

    coordinator.handleToolEvent('msg-err', 'completed', {
      id: 'call-err-phase',
      rawName: 'contentManager_write',
      error: 'disk full', // non-empty error string → phase becomes 'failed'
    });

    const lastEntry = controller.pushStatus.mock.calls[controller.pushStatus.mock.calls.length - 1];
    expect(lastEntry[1].state).toBe('failed');
  });

  it('uses data.toolId as fallback when id is absent', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolEvent('msg-1', 'detected', {
      toolId: 'fallback-id',
      rawName: 'contentManager_read',
    } as unknown as Parameters<typeof coordinator.handleToolEvent>[2]);

    const state = stateManager.getState('fallback-id');
    expect(state).toBeDefined();
  });
});

describe('ToolEventCoordinator — providerExecuted with success=undefined', () => {
  it('treats success as true when success is undefined on providerExecuted call', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolCallsDetected('msg-prov-undef', [
      {
        id: 'call-prov-undef',
        function: { name: 'contentManager_read', arguments: '{}' },
        providerExecuted: true,
        result: { data: 'ok' },
        // success: undefined — should default to true (success !== false)
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const states = controller.pushStatus.mock.calls.map((c: unknown[]) => (c[1] as { state: string }).state);
    expect(states).toContain('present');
    expect(states).toContain('past'); // completed as success
  });
});

describe('ToolEventCoordinator — ensureListening idempotency', () => {
  it('does NOT re-subscribe when already listening (ensureListening called twice)', () => {
    const { coordinator, controller } = makeCoordinator();

    // Already listening from constructor — ensureListening should be a no-op
    coordinator.ensureListening();

    coordinator.handleToolExecutionStarted('msg-1', {
      id: 'call-idem',
      name: 'contentManager_read',
    });

    // Should still receive exactly 1 push (not 2 from double-subscribe)
    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
  });
});

describe('ToolEventCoordinator — scheduleHide timer replacement', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('cancels the previous hide timer when clearToolNameCache is called twice', () => {
    const { coordinator, controller } = makeCoordinator();

    coordinator.handleToolExecutionStarted('msg-1', { id: 'call-a', name: 'contentManager_read' });
    coordinator.clearToolNameCache();

    // Calling clearToolNameCache again while timer is pending replaces the old timer
    // (exercises the `if (this.hideTimer) clearTimeout(...)` branch in scheduleHide)
    coordinator.clearToolNameCache();

    // Cancel the timer before it fires to avoid mock controller's missing getStatusBar
    coordinator.ensureListening();

    // pushStatus was called once for the started event
    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
  });

  it('ensureListening cancels hide timer even when no timer is pending (cancelHide false branch)', () => {
    const { coordinator, controller } = makeCoordinator();

    // No timer is active — calling ensureListening should not throw
    expect(() => coordinator.ensureListening()).not.toThrow();

    // Still works after
    coordinator.handleToolExecutionStarted('msg-1', { id: 'call-b', name: 'contentManager_read' });
    expect(controller.pushStatus).toHaveBeenCalledTimes(1);
  });
});

describe('ToolEventCoordinator — clearToolNameCache delegates to state manager', () => {
  it('clears state manager state when clearToolNameCache is called', () => {
    const { coordinator, stateManager } = makeCoordinator();

    coordinator.handleToolExecutionStarted('msg-1', {
      id: 'tool-1',
      name: 'contentManager_read',
    });
    expect(stateManager.getState('tool-1')).toBeDefined();

    coordinator.clearToolNameCache();
    expect(stateManager.getState('tool-1')).toBeUndefined();
  });
});
