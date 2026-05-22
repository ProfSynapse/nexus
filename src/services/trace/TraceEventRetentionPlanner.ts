import { TraceAddedEvent, WorkspaceEvent } from '../../database/interfaces/StorageEvents';

export interface TraceRetentionPolicy {
  /**
   * Remove trace_added events older than this timestamp.
   * Non-trace workspace events are always retained.
   */
  removeTraceEventsBefore?: number;

  /**
   * Keep only the newest N trace_added events in each workspace/session group.
   * Non-trace workspace events are always retained.
   */
  maxTraceEventsPerSession?: number;
}

export interface TraceRetentionPlan {
  retainedEvents: WorkspaceEvent[];
  removedTraceEvents: TraceAddedEvent[];
  backupEvents: TraceAddedEvent[];
  backupRequired: boolean;
  summary: {
    totalEvents: number;
    retainedEvents: number;
    removedTraceEvents: number;
  };
}

interface IndexedTraceEvent {
  event: TraceAddedEvent;
  index: number;
}

/**
 * Builds a non-destructive retention plan for workspace JSONL trace events.
 * Callers that choose to rewrite a stream must persist backupEvents first.
 */
export class TraceEventRetentionPlanner {
  plan(events: WorkspaceEvent[], policy: TraceRetentionPolicy): TraceRetentionPlan {
    const removableTraceIndexes = new Set<number>();

    for (const trace of this.findTracesOlderThanPolicy(events, policy)) {
      removableTraceIndexes.add(trace.index);
    }

    for (const trace of this.findTracesOutsideSessionLimit(events, policy)) {
      removableTraceIndexes.add(trace.index);
    }

    const retainedEvents: WorkspaceEvent[] = [];
    const removedTraceEvents: TraceAddedEvent[] = [];

    events.forEach((event, index) => {
      if (event.type === 'trace_added' && removableTraceIndexes.has(index)) {
        removedTraceEvents.push(event);
        return;
      }

      retainedEvents.push(event);
    });

    return {
      retainedEvents,
      removedTraceEvents,
      backupEvents: [...removedTraceEvents],
      backupRequired: removedTraceEvents.length > 0,
      summary: {
        totalEvents: events.length,
        retainedEvents: retainedEvents.length,
        removedTraceEvents: removedTraceEvents.length
      }
    };
  }

  private findTracesOlderThanPolicy(
    events: WorkspaceEvent[],
    policy: TraceRetentionPolicy
  ): IndexedTraceEvent[] {
    if (policy.removeTraceEventsBefore === undefined) {
      return [];
    }

    return this.indexTraceEvents(events).filter(
      trace => trace.event.timestamp < (policy.removeTraceEventsBefore as number)
    );
  }

  private findTracesOutsideSessionLimit(
    events: WorkspaceEvent[],
    policy: TraceRetentionPolicy
  ): IndexedTraceEvent[] {
    if (policy.maxTraceEventsPerSession === undefined) {
      return [];
    }

    const limit = Math.max(0, policy.maxTraceEventsPerSession);
    const groups = new Map<string, IndexedTraceEvent[]>();

    for (const trace of this.indexTraceEvents(events)) {
      const key = `${trace.event.workspaceId}\u0000${trace.event.sessionId}`;
      const existing = groups.get(key) ?? [];
      existing.push(trace);
      groups.set(key, existing);
    }

    const removable: IndexedTraceEvent[] = [];
    for (const group of groups.values()) {
      group.sort((left, right) => {
        const timestampDelta = right.event.timestamp - left.event.timestamp;
        return timestampDelta !== 0 ? timestampDelta : right.index - left.index;
      });
      removable.push(...group.slice(limit));
    }

    return removable;
  }

  private indexTraceEvents(events: WorkspaceEvent[]): IndexedTraceEvent[] {
    const traces: IndexedTraceEvent[] = [];

    events.forEach((event, index) => {
      if (event.type === 'trace_added') {
        traces.push({ event, index });
      }
    });

    return traces;
  }
}
