/**
 * ToolStatusPipeline integration tests
 *
 * Exercises the full pipeline from event sources through:
 *   ToolEventCoordinator → ToolCallStateManager → ToolStatusBarController → ToolStatusBar (mocked)
 *
 * Uses real implementations for StateManager, Coordinator, and Controller.
 * Only mocks ToolStatusBar (DOM layer) and StreamingController (messageId provider).
 */

import { ToolCallStateManager } from '../../src/ui/chat/services/ToolCallStateManager';
import { ToolEventCoordinator } from '../../src/ui/chat/coordinators/ToolEventCoordinator';
import { ToolStatusBarController } from '../../src/ui/chat/controllers/ToolStatusBarController';
import type { ToolStatusBar, ToolStatusEntry } from '../../src/ui/chat/components/ToolStatusBar';
import type { StreamingController } from '../../src/ui/chat/controllers/StreamingController';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface CapturedStatus {
  text: string;
  state: 'present' | 'past' | 'failed';
}

function makeMockStatusBar() {
  const captured: CapturedStatus[] = [];
  const mock = {
    pushStatus: jest.fn((entry: ToolStatusEntry) => {
      captured.push({ text: entry.text, state: entry.state });
    }),
    clearStatus: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    cleanup: jest.fn(),
    getAgentSlotEl: jest.fn(() => document.createElement('div')),
    getContextBadge: jest.fn(),
    updateContext: jest.fn(),
  };
  return { mock: mock as unknown as ToolStatusBar, captured, raw: mock };
}

function makeMockStreamingController(messageId: string | null = 'msg-1') {
  let currentId = messageId;
  return {
    mock: {
      getCurrentMessageId: jest.fn(() => currentId),
    } as unknown as StreamingController,
    setMessageId(id: string | null) {
      currentId = id;
      (this.mock as unknown as { getCurrentMessageId: jest.Mock }).getCurrentMessageId.mockReturnValue(id);
    },
  };
}

function makeMockComponent() {
  const cleanups: (() => void)[] = [];
  return {
    register: jest.fn((fn: () => void) => { cleanups.push(fn); }),
    dispose() { cleanups.forEach(fn => fn()); },
  };
}

/**
 * Wire the full pipeline with real implementations except ToolStatusBar and StreamingController.
 */
function createPipeline(options: { messageId?: string | null } = {}) {
  const statusBar = makeMockStatusBar();
  const streaming = makeMockStreamingController('messageId' in options ? options.messageId! : 'msg-1');
  const component = makeMockComponent();

  const stateManager = new ToolCallStateManager();
  const controller = new ToolStatusBarController(
    statusBar.mock,
    streaming.mock,
    component as unknown as import('obsidian').Component,
  );
  const coordinator = new ToolEventCoordinator(controller, stateManager);

  return {
    coordinator,
    stateManager,
    controller,
    statusBar,
    streaming,
    component,
    /** Convenience: all captured pushStatus entries */
    get entries() { return statusBar.captured; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolStatusPipeline — integration', () => {

  // ------------------------------------------------------------------
  // 1. Happy path — single tool: detected → started → completed
  // ------------------------------------------------------------------
  describe('happy path — single tool lifecycle', () => {
    it('shows present-tense label on detection, then past-tense on completion', () => {
      const { coordinator, entries } = createPipeline();

      // Detection: LLM emits tool call
      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_read_1',
          function: { name: 'contentManager_read', arguments: '{"filePath":"notes.md"}' },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');
      expect(entries[0].text).toMatch(/Running|Read/i);

      // Execution starts
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_read_1',
        name: 'contentManager_read',
        parameters: { filePath: 'notes.md' },
      });

      expect(entries).toHaveLength(2);
      expect(entries[1].state).toBe('present');

      // Execution completes
      coordinator.handleToolExecutionCompleted('msg-1', 'call_read_1', { content: '...' }, true);

      expect(entries).toHaveLength(3);
      expect(entries[2].state).toBe('past');
      expect(entries[2].text).toMatch(/Ran|Read/i);
    });
  });

  // ------------------------------------------------------------------
  // 2. Serial batch — useTools with 2 inner calls
  // ------------------------------------------------------------------
  describe('serial batch — useTools with 2 inner calls', () => {
    it('unwraps inner calls and shows present-tense labels, then past-tense on completion', () => {
      const { coordinator, entries, stateManager } = createPipeline();

      // LLM calls useTools with 2 inner calls
      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_usetools_1',
          function: {
            name: 'toolManager_useTools',
            arguments: JSON.stringify({
              context: {},
              calls: [
                { agent: 'storageManager', tool: 'move', parameters: { source: 'a.md', target: 'b.md' } },
                { agent: 'storageManager', tool: 'open', parameters: { path: 'b.md' } },
              ],
            }),
          },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      // Each inner call gets a unique ID: call_usetools_1_0 (move) and call_usetools_1_1 (open).
      // Both should receive detected events.
      expect(entries.length).toBe(2);
      expect(entries[0].state).toBe('present');
      expect(entries[1].state).toBe('present');

      // Execution path fires with matching suffixed IDs.
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_usetools_1_0',
        name: 'storageManager_move',
        parameters: { source: 'a.md', target: 'b.md' },
      });

      // started is forward from detected, so this advances the state
      const startedEntries = entries.filter(e => e.state === 'present');
      expect(startedEntries.length).toBeGreaterThanOrEqual(2);

      // First inner tool completes
      coordinator.handleToolExecutionCompleted('msg-1', 'call_usetools_1_0', {}, true);

      const pastEntries = entries.filter(e => e.state === 'past');
      expect(pastEntries.length).toBeGreaterThanOrEqual(1);

      // Second inner tool starts — unique ID call_usetools_1_1, separate lifecycle
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_usetools_1_1',
        name: 'storageManager_open',
        parameters: { path: 'b.md' },
      });

      // Second tool should advance from detected to started
      const state1 = stateManager.getState('call_usetools_1_1');
      expect(state1?.phase).toBe('started');

      // Second inner tool completes
      coordinator.handleToolExecutionCompleted('msg-1', 'call_usetools_1_1', {}, true);

      const state2 = stateManager.getState('call_usetools_1_1');
      expect(state2?.phase).toBe('completed');
    });
  });

  // ------------------------------------------------------------------
  // 3. Race condition — late detection after completion
  // ------------------------------------------------------------------
  describe('race condition — late detection after completion', () => {
    it('rejects late detection event after tool has completed', () => {
      const { coordinator, entries, stateManager } = createPipeline();

      // Execution starts (skipping detection)
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_race',
        name: 'contentManager_read',
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');

      // Execution completes
      coordinator.handleToolExecutionCompleted('msg-1', 'call_race', { data: 'ok' }, true);

      expect(entries).toHaveLength(2);
      expect(entries[1].state).toBe('past');

      const entriesBeforeLateDetection = entries.length;

      // Late detection event arrives (streaming parser delay)
      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_race',
          function: { name: 'contentManager_read', arguments: '{}' },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      // No new entry — the state machine rejected the regression
      expect(entries).toHaveLength(entriesBeforeLateDetection);
      expect(stateManager.getState('call_race')?.phase).toBe('completed');
    });
  });

  // ------------------------------------------------------------------
  // 4. ID correlation — suffix matching
  // ------------------------------------------------------------------
  describe('ID correlation — execution suffix matching', () => {
    it('correlates call_abc_0 (execution) with call_abc (detection) via prefix matching', () => {
      const { coordinator, entries, stateManager } = createPipeline();

      // Detection path fires with raw LLM ID (no suffix)
      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_abc',
          function: { name: 'contentManager_read', arguments: '{"filePath":"test.md"}' },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');

      // Execution path fires with suffixed ID
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_abc_0',
        name: 'contentManager_read',
        parameters: { filePath: 'test.md' },
      });

      // Should correlate — started is forward from detected, so a new event fires
      expect(entries).toHaveLength(2);
      expect(entries[1].state).toBe('present');

      // Both IDs resolve to the same canonical entry
      const stateByOriginal = stateManager.getState('call_abc');
      expect(stateByOriginal).toBeDefined();
      expect(stateByOriginal!.phase).toBe('started');

      // Complete using the suffixed ID
      coordinator.handleToolExecutionCompleted('msg-1', 'call_abc_0', { content: 'done' }, true);

      expect(entries).toHaveLength(3);
      expect(entries[2].state).toBe('past');
      expect(stateManager.getState('call_abc')?.phase).toBe('completed');
    });
  });

  // ------------------------------------------------------------------
  // 5. Failed tool
  // ------------------------------------------------------------------
  describe('failed tool — shows failed-tense label', () => {
    it('shows "Failed to run X" when tool completes with success: false', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_fail',
        name: 'storageManager_move',
        parameters: { source: 'a.md', target: 'b.md' },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');

      coordinator.handleToolExecutionCompleted('msg-1', 'call_fail', null, false, 'permission denied');

      expect(entries).toHaveLength(2);
      expect(entries[1].state).toBe('failed');
      expect(entries[1].text).toMatch(/Failed to run/i);
    });

    it('shows failed-tense via handleToolEvent with error string', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolEvent('msg-1', 'started', {
        id: 'call_fail2',
        rawName: 'contentManager_write',
      });

      coordinator.handleToolEvent('msg-1', 'completed', {
        id: 'call_fail2',
        rawName: 'contentManager_write',
        success: false,
        error: 'disk full',
      });

      expect(entries).toHaveLength(2);
      expect(entries[1].state).toBe('failed');
      expect(entries[1].text).toMatch(/Failed to run/i);
    });
  });

  // ------------------------------------------------------------------
  // 6. getTools/useTools filtered
  // ------------------------------------------------------------------
  describe('getTools/useTools filtering', () => {
    it('getTools events do NOT reach the status bar via handleToolCallsDetected', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_get',
          function: { name: 'toolManager_getTools', arguments: '{}' },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      expect(entries).toHaveLength(0);
    });

    it('getTools events do NOT reach the status bar via handleToolEvent', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolEvent('msg-1', 'detected', {
        id: 'call_get2',
        name: 'getTools',
      });

      expect(entries).toHaveLength(0);
    });

    it('useTools wrapper events do NOT reach the status bar via handleToolEvent', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolEvent('msg-1', 'completed', {
        id: 'call_use',
        name: 'useTools',
      });

      expect(entries).toHaveLength(0);
    });

    it('useTools wrapper is filtered but inner calls pass through in handleToolCallsDetected', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolCallsDetected('msg-1', [
        {
          id: 'call_wrapper',
          function: {
            name: 'toolManager_useTools',
            arguments: JSON.stringify({
              context: {},
              calls: [
                { agent: 'contentManager', tool: 'read', parameters: { filePath: 'x.md' } },
              ],
            }),
          },
        },
      ] as Parameters<typeof coordinator.handleToolCallsDetected>[1]);

      // The wrapper is filtered, but the inner call is emitted
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');
      expect(entries[0].text).toMatch(/Running|Read/i);
    });
  });

  // ------------------------------------------------------------------
  // 7. Auto-clear after streaming ends
  // ------------------------------------------------------------------
  describe('auto-clear after streaming ends', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('clears status bar text ~2s after clearToolNameCache()', () => {
      const { coordinator, statusBar } = createPipeline();

      // Fire a tool event to have something showing
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_clear_test',
        name: 'contentManager_read',
      });

      expect(statusBar.raw.pushStatus).toHaveBeenCalled();

      // End streaming
      coordinator.clearToolNameCache();

      // Status bar should NOT have cleared yet
      expect(statusBar.raw.clearStatus).not.toHaveBeenCalled();

      // Advance 2 seconds
      jest.advanceTimersByTime(2000);

      expect(statusBar.raw.clearStatus).toHaveBeenCalledTimes(1);
    });

    it('new events after clearToolNameCache() do NOT reach the status bar (listener unsubscribed)', () => {
      const { coordinator, entries } = createPipeline();

      // Fire initial event
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_pre_clear',
        name: 'contentManager_read',
      });

      const countBefore = entries.length;

      // End streaming — unsubscribes the listener
      coordinator.clearToolNameCache();

      // New event after clear
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_post_clear',
        name: 'contentManager_write',
      });

      // No new entries — listener was unsubscribed
      expect(entries).toHaveLength(countBefore);
    });

    it('after ensureListening(), events flow again', () => {
      const { coordinator, entries } = createPipeline();

      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_a',
        name: 'contentManager_read',
      });

      const countAfterFirst = entries.length;

      // Clear (unsubscribe)
      coordinator.clearToolNameCache();

      // Re-subscribe
      coordinator.ensureListening();

      // New event should now reach the status bar
      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_b',
        name: 'storageManager_list',
      });

      expect(entries.length).toBeGreaterThan(countAfterFirst);
      const latest = entries[entries.length - 1];
      expect(latest.state).toBe('present');
    });

    it('ensureListening() cancels pending hide timer', () => {
      const { coordinator, statusBar } = createPipeline();

      coordinator.handleToolExecutionStarted('msg-1', {
        id: 'call_cancel',
        name: 'contentManager_read',
      });

      // Start hide sequence
      coordinator.clearToolNameCache();

      // Before the 2s timer fires, re-subscribe
      jest.advanceTimersByTime(500);
      coordinator.ensureListening();

      // Advance past the original 2s mark
      jest.advanceTimersByTime(2000);

      // clearStatus should NOT have been called — the timer was cancelled
      expect(statusBar.raw.clearStatus).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // 8. Subagent filter — messageId mismatch
  // ------------------------------------------------------------------
  describe('subagent filter — messageId mismatch', () => {
    it('drops present-tense events from a different messageId', () => {
      const { coordinator, entries } = createPipeline({ messageId: 'msg-current' });

      // Event from a different message (e.g., a subagent)
      coordinator.handleToolExecutionStarted('msg-subagent', {
        id: 'call_sub',
        name: 'contentManager_read',
      });

      // The ToolStatusBarController filters present-tense events whose
      // messageId doesn't match the streaming controller's current messageId.
      // The state manager still fires the event, but the controller drops it
      // before forwarding to the status bar.
      expect(entries).toHaveLength(0);
    });

    it('allows terminal (past/failed) events from a different messageId', () => {
      const { coordinator, entries, stateManager } = createPipeline({ messageId: 'msg-current' });

      // Start a tool on the subagent message — this will be dropped by the controller
      // but the state manager still records it
      coordinator.handleToolExecutionStarted('msg-subagent', {
        id: 'call_sub_term',
        name: 'contentManager_read',
      });

      expect(entries).toHaveLength(0);

      // Complete it — terminal state should pass through the controller's filter
      coordinator.handleToolExecutionCompleted('msg-subagent', 'call_sub_term', {}, true);

      // The controller allows past/failed events through regardless of messageId
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('past');
    });

    it('allows events when streaming messageId is null (streaming just started)', () => {
      const { coordinator, entries } = createPipeline({ messageId: null });

      coordinator.handleToolExecutionStarted('msg-any', {
        id: 'call_null',
        name: 'contentManager_read',
      });

      // When currentMsgId is null, all events pass through
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');
    });

    it('events matching the current messageId always pass through', () => {
      const { coordinator, entries } = createPipeline({ messageId: 'msg-match' });

      coordinator.handleToolExecutionStarted('msg-match', {
        id: 'call_match',
        name: 'storageManager_move',
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('present');
    });
  });
});
