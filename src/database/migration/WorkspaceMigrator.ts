/**
 * Location: src/database/migration/WorkspaceMigrator.ts
 *
 * Migrates workspace data from legacy JSON to JSONL format.
 * Handles workspaces, sessions, states, and traces.
 *
 * Extends BaseMigrator for DRY file iteration and status tracking.
 * Uses batched writes for performance (single file operation per workspace).
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../storage/JSONLWriter';
import {
  IndividualWorkspace,
  SessionData,
  MemoryTrace,
  StateData,
} from '../../types/storage/StorageTypes';
import {
  WorkspaceCreatedEvent,
  SessionCreatedEvent,
  StateSavedEvent,
  TraceAddedEvent,
  WorkspaceEvent,
} from '../interfaces/StorageEvents';
import { LegacyFileScanner } from './LegacyFileScanner';
import { MigrationStatusTracker } from './MigrationStatusTracker';
import { BaseMigrator } from './BaseMigrator';
import { WorkspaceMigrationResult, MigrationCategory } from './types';

export class WorkspaceMigrator extends BaseMigrator<WorkspaceMigrationResult> {
  protected readonly category: MigrationCategory = 'workspaces';

  constructor(
    app: App,
    jsonlWriter: JSONLWriter,
    fileScanner: LegacyFileScanner,
    statusTracker: MigrationStatusTracker
  ) {
    super(app, jsonlWriter, fileScanner, statusTracker);
  }

  protected async listFiles(): Promise<string[]> {
    return this.fileScanner.listLegacyWorkspaceFilePaths();
  }

  protected createEmptyResult(): WorkspaceMigrationResult {
    return {
      workspaces: 0,
      sessions: 0,
      states: 0,
      traces: 0,
      errors: [],
    };
  }

  /**
   * Migrate a single workspace file using batched writes for performance
   */
  protected async migrateFile(
    filePath: string,
    result: WorkspaceMigrationResult
  ): Promise<void> {
    // Read legacy workspace JSON via adapter
    const content = await this.app.vault.adapter.read(filePath);
    let workspace: IndividualWorkspace;

    try {
      workspace = JSON.parse(content);
    } catch (parseError) {
      console.error(`[WorkspaceMigrator] Failed to parse workspace JSON: ${filePath}`, parseError);
      return;
    }

    if (!workspace.id || !workspace.name) {
      return;
    }

    // Collect all events for this workspace
    const events: Array<Omit<WorkspaceEvent, 'id' | 'deviceId' | 'timestamp'>> = [];

    // Workspace created event
    events.push({
      type: 'workspace_created',
      data: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        rootFolder: workspace.rootFolder,
        created: workspace.created,
        // Default to true if not specified (workspaces should be active by default)
        isActive: workspace.isActive !== undefined ? workspace.isActive : true,
        contextJson: workspace.context ? JSON.stringify(workspace.context) : undefined,
      },
    } as Omit<WorkspaceCreatedEvent, 'id' | 'deviceId' | 'timestamp'>);
    result.workspaces++;

    // Collect session, state, and trace events
    if (workspace.sessions) {
      const sessionEntries = Object.entries(workspace.sessions);
      for (const [sessionId, sessionData] of sessionEntries) {
        this.collectSessionEvents(workspace.id, sessionId, sessionData, events, result);
      }
    }

    // Write all events in a single operation
    const jsonlPath = `workspaces/ws_${workspace.id}.jsonl`;
    await this.jsonlWriter.appendEvents(jsonlPath, events);
  }

  /**
   * Collect events for a session (synchronous - no I/O)
   */
  private collectSessionEvents(
    workspaceId: string,
    sessionId: string,
    sessionData: SessionData,
    events: Array<Omit<WorkspaceEvent, 'id' | 'deviceId' | 'timestamp'>>,
    result: WorkspaceMigrationResult
  ): void {
    // Session created event
    events.push({
      type: 'session_created',
      workspaceId,
      data: {
        id: sessionId,
        name: sessionData.name || `Session ${sessionId}`,
        description: sessionData.description,
        startTime: sessionData.startTime,
      },
    } as Omit<SessionCreatedEvent, 'id' | 'deviceId' | 'timestamp'>);
    result.sessions++;

    // Collect states
    if (sessionData.states) {
      const stateEntries = Object.entries(sessionData.states);
      for (const [stateId, stateData] of stateEntries) {
        events.push({
          type: 'state_saved',
          workspaceId,
          sessionId,
          data: {
            id: stateId,
            name: stateData.name,
            created: stateData.created,
            stateJson: JSON.stringify(stateData.state),
          },
        } as Omit<StateSavedEvent, 'id' | 'deviceId' | 'timestamp'>);
        result.states++;
      }
    }

    // Collect traces
    if (sessionData.memoryTraces) {
      const traceEntries = Object.entries(sessionData.memoryTraces);
      for (const [traceId, traceData] of traceEntries) {
        events.push({
          type: 'trace_added',
          workspaceId,
          sessionId,
          data: {
            id: traceId,
            content: traceData.content,
            traceType: traceData.type,
            metadataJson: traceData.metadata ? JSON.stringify(traceData.metadata) : undefined,
          },
        } as Omit<TraceAddedEvent, 'id' | 'deviceId' | 'timestamp'>);
        result.traces++;
      }
    }
  }
}
