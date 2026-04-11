/**
 * ToolEventCoordinator unit tests — FIRST unit coverage on this file.
 *
 * PLAN MANDATE — sink-swap integration test:
 *   Every dispatch path MUST route through ToolStatusBarController.handleToolEvent.
 *   No legacy fallback path should remain in the file.
 *
 * This suite verifies:
 *   1. handleToolCallsDetected → emits a 'detected' event per tool call
 *   2. handleToolCallsDetected → emits an additional 'completed' event for providerExecuted calls
 *   3. handleToolExecutionStarted → emits 'started'
 *   4. handleToolExecutionCompleted → emits 'completed' with the provided payload
 *   5. handleToolEvent (generic) → enriches metadata and forwards to the controller
 *   6. String-encoded tool parameters are JSON-parsed when possible
 *   7. No public method of ToolEventCoordinator ever touches anything but the
 *      provided controller (verified by a tight mock with NO additional methods).
 */

import { ToolEventCoordinator } from '../../src/ui/chat/coordinators/ToolEventCoordinator';
import type { ToolStatusBarController, ToolStatusEventData } from '../../src/ui/chat/controllers/ToolStatusBarController';

type MockController = {
  handleToolEvent: jest.Mock<void, [string, 'detected' | 'updated' | 'started' | 'completed', ToolStatusEventData]>;
};

function makeController(): MockController {
  return {
    handleToolEvent: jest.fn(),
  };
}

function makeCoordinator(controller: MockController): ToolEventCoordinator {
  return new ToolEventCoordinator(controller as unknown as ToolStatusBarController);
}

describe('ToolEventCoordinator — sink-swap (PLAN MANDATE)', () => {
  it('routes handleToolExecutionStarted through controller.handleToolEvent with "started"', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolExecutionStarted('msg-1', {
      id: 'tool-abc',
      name: 'contentManager_read',
      parameters: { filePath: 'notes.md' },
    });

    expect(controller.handleToolEvent).toHaveBeenCalledTimes(1);
    const [messageId, event, data] = controller.handleToolEvent.mock.calls[0];
    expect(messageId).toBe('msg-1');
    expect(event).toBe('started');
    expect(data.id).toBe('tool-abc');
  });

  it('routes handleToolExecutionCompleted through controller.handleToolEvent with "completed"', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolExecutionCompleted('msg-2', 'tool-xyz', { value: 42 }, true);

    expect(controller.handleToolEvent).toHaveBeenCalledTimes(1);
    const [messageId, event, data] = controller.handleToolEvent.mock.calls[0];
    expect(messageId).toBe('msg-2');
    expect(event).toBe('completed');
    expect(data.toolId).toBe('tool-xyz');
    expect(data.success).toBe(true);
    expect(data.result).toEqual({ value: 42 });
  });

  it('forwards error string on completion failure', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolExecutionCompleted('msg-3', 'tool-err', null, false, 'permission denied');

    const [, , data] = controller.handleToolEvent.mock.calls[0];
    expect(data.success).toBe(false);
    expect(data.error).toBe('permission denied');
  });

  it('routes handleToolEvent (generic) through controller.handleToolEvent with enriched data', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolEvent('msg-4', 'detected', {
      rawName: 'contentManager_read',
      parameters: { filePath: 'a.md' },
    });

    expect(controller.handleToolEvent).toHaveBeenCalledTimes(1);
    const [messageId, event, data] = controller.handleToolEvent.mock.calls[0];
    expect(messageId).toBe('msg-4');
    expect(event).toBe('detected');
    // Enrichment adds metadata fields
    expect(data.technicalName).toBeDefined();
    expect(data.displayName).toBeDefined();
    expect(data.rawName).toBe('contentManager_read');
    expect(data.parameters).toEqual({ filePath: 'a.md' });
  });
});

describe('ToolEventCoordinator — handleToolCallsDetected', () => {
  it('emits a "detected" event for each tool call', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

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

    // Two tool calls → two 'detected' events
    const detectedCalls = controller.handleToolEvent.mock.calls.filter(
      (call) => call[1] === 'detected'
    );
    expect(detectedCalls).toHaveLength(2);
    expect(detectedCalls[0][2].id).toBe('call-1');
    expect(detectedCalls[1][2].id).toBe('call-2');
  });

  it('parses string-encoded arguments into structured parameters', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolCallsDetected('msg-parse', [
      {
        id: 'call-parse',
        function: { name: 'contentManager_read', arguments: '{"filePath":"a.md","limit":10}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const [, , data] = controller.handleToolEvent.mock.calls[0];
    expect(data.parameters).toEqual({ filePath: 'a.md', limit: 10 });
  });

  it('leaves malformed JSON arguments as a raw string rather than throwing', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    expect(() => {
      coordinator.handleToolCallsDetected('msg-bad', [
        {
          id: 'call-bad',
          function: { name: 'contentManager_read', arguments: '{not-valid-json' },
        },
      ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);
    }).not.toThrow();

    const [, , data] = controller.handleToolEvent.mock.calls[0];
    expect(data.parameters).toBe('{not-valid-json');
  });

  it('emits a follow-up "completed" event for providerExecuted tool calls with results', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolCallsDetected('msg-provider', [
      {
        id: 'call-provider',
        function: { name: 'searchManager_searchContent', arguments: '{"query":"x"}' },
        providerExecuted: true,
        result: { matches: 3 },
        success: true,
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    const events = controller.handleToolEvent.mock.calls.map((call) => call[1]);
    expect(events).toContain('detected');
    expect(events).toContain('completed');
    // Total = 2 (detected + completed) for one providerExecuted call
    expect(controller.handleToolEvent).toHaveBeenCalledTimes(2);

    const completedCall = controller.handleToolEvent.mock.calls.find((call) => call[1] === 'completed');
    expect(completedCall).toBeDefined();
    expect(completedCall?.[2].toolId).toBe('call-provider');
    expect(completedCall?.[2].success).toBe(true);
    expect(completedCall?.[2].result).toEqual({ matches: 3 });
  });

  it('does NOT emit a follow-up "completed" event for non-provider tool calls', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolCallsDetected('msg-regular', [
      {
        id: 'call-regular',
        function: { name: 'contentManager_read', arguments: '{"filePath":"a.md"}' },
        // No providerExecuted — regular tool call that will complete via
        // handleToolExecutionCompleted later.
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

    expect(controller.handleToolEvent).toHaveBeenCalledTimes(1);
    expect(controller.handleToolEvent.mock.calls[0][1]).toBe('detected');
  });

  it('handles an empty tool call array without calling the controller', () => {
    const controller = makeController();
    const coordinator = makeCoordinator(controller);

    coordinator.handleToolCallsDetected('msg-empty', []);

    expect(controller.handleToolEvent).not.toHaveBeenCalled();
  });
});

describe('ToolEventCoordinator — sink-swap invariant (no legacy fallback)', () => {
  it('never invokes any method on the controller except handleToolEvent', () => {
    // Use a Proxy to detect access to anything other than handleToolEvent
    const seenMethods = new Set<string>();
    const controllerMock = {
      handleToolEvent: jest.fn(),
    };
    const controller = new Proxy(controllerMock, {
      get(target, prop) {
        if (typeof prop === 'string') {
          seenMethods.add(prop);
        }
        return (target as Record<string | symbol, unknown>)[prop as string];
      },
    });

    const coordinator = new ToolEventCoordinator(controller as unknown as ToolStatusBarController);

    // Exercise every public dispatch path
    coordinator.handleToolCallsDetected('m', [
      {
        id: 'c1',
        function: { name: 'test', arguments: '{}' },
      },
    ] as unknown as Parameters<typeof coordinator.handleToolCallsDetected>[1]);
    coordinator.handleToolExecutionStarted('m', { id: 'c2', name: 'test' });
    coordinator.handleToolExecutionCompleted('m', 'c2', null, true);
    coordinator.handleToolEvent('m', 'detected', { name: 'test' });

    // The ONLY method accessed on the controller must be handleToolEvent
    const accessedFunctionalMethods = Array.from(seenMethods).filter(
      (prop) => prop !== 'then' // avoid false positives from Jest's await handling
    );
    expect(accessedFunctionalMethods).toEqual(['handleToolEvent']);
    expect(controllerMock.handleToolEvent).toHaveBeenCalled();
  });
});
