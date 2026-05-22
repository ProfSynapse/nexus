import { WorkspaceEvent } from '../../src/database/interfaces/StorageEvents';
import { TraceEventRetentionPlanner } from '../../src/services/trace/TraceEventRetentionPlanner';

function baseEvent(id: string, type: WorkspaceEvent['type'], timestamp: number): WorkspaceEvent {
  if (type === 'session_created') {
    return {
      id,
      type,
      deviceId: 'device-1',
      timestamp,
      workspaceId: 'workspace-1',
      data: {
        id: `session-${id}`,
        name: `Session ${id}`,
        startTime: timestamp
      }
    };
  }

  if (type === 'state_saved') {
    return {
      id,
      type,
      deviceId: 'device-1',
      timestamp,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      data: {
        id: `state-${id}`,
        name: `State ${id}`,
        created: timestamp,
        stateJson: '{}'
      }
    };
  }

  return {
    id,
    type: 'trace_added',
    deviceId: 'device-1',
    timestamp,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    data: {
      id: `trace-${id}`,
      content: `Trace ${id}`,
      traceType: 'tool_call'
    }
  };
}

describe('TraceEventRetentionPlanner', () => {
  it('removes only trace_added events older than the retention cutoff', () => {
    const planner = new TraceEventRetentionPlanner();
    const events: WorkspaceEvent[] = [
      baseEvent('session-old', 'session_created', 100),
      baseEvent('trace-old', 'trace_added', 100),
      baseEvent('state-old', 'state_saved', 100),
      baseEvent('trace-new', 'trace_added', 300)
    ];

    const plan = planner.plan(events, { removeTraceEventsBefore: 200 });

    expect(plan.retainedEvents.map(event => event.id)).toEqual([
      'session-old',
      'state-old',
      'trace-new'
    ]);
    expect(plan.removedTraceEvents.map(event => event.id)).toEqual(['trace-old']);
    expect(plan.backupEvents).toEqual(plan.removedTraceEvents);
    expect(plan.backupRequired).toBe(true);
  });

  it('keeps the newest trace_added events per workspace/session and preserves other events', () => {
    const planner = new TraceEventRetentionPlanner();
    const events: WorkspaceEvent[] = [
      baseEvent('session-1', 'session_created', 10),
      baseEvent('trace-oldest', 'trace_added', 100),
      baseEvent('trace-middle', 'trace_added', 200),
      baseEvent('trace-newest', 'trace_added', 300),
      {
        ...baseEvent('trace-other-session', 'trace_added', 50),
        sessionId: 'session-2'
      }
    ];

    const plan = planner.plan(events, { maxTraceEventsPerSession: 2 });

    expect(plan.retainedEvents.map(event => event.id)).toEqual([
      'session-1',
      'trace-middle',
      'trace-newest',
      'trace-other-session'
    ]);
    expect(plan.removedTraceEvents.map(event => event.id)).toEqual(['trace-oldest']);
    expect(plan.summary).toEqual({
      totalEvents: 5,
      retainedEvents: 4,
      removedTraceEvents: 1
    });
  });

  it('is non-destructive when no trace events match policy', () => {
    const planner = new TraceEventRetentionPlanner();
    const events: WorkspaceEvent[] = [
      baseEvent('session-1', 'session_created', 10),
      baseEvent('trace-new', 'trace_added', 300)
    ];

    const plan = planner.plan(events, { removeTraceEventsBefore: 200 });

    expect(plan.retainedEvents).toEqual(events);
    expect(plan.removedTraceEvents).toEqual([]);
    expect(plan.backupRequired).toBe(false);
  });
});
