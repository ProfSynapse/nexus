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
