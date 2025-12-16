import { normalizePath, Plugin } from 'obsidian';
import { FileSystemService } from '../storage/FileSystemService';
import { normalizeLegacyTraceMetadata } from '../memory/LegacyTraceMetadataNormalizer';
import { VaultOperations } from '../../core/VaultOperations';

const TRACE_SCHEMA_VERSION = 1;

interface TraceSchemaStatus {
  version: number;
  migratedAt: number;
}

export class TraceSchemaMigrationService {
  private markerPath = normalizePath('.workspaces/.trace-schema.json');
  private workspacesPath = normalizePath('.workspaces');
  private backupsPath = normalizePath('.workspaces/backups');

  constructor(
    private plugin: Plugin,
    private fileSystem: FileSystemService,
    private vaultOperations: VaultOperations
  ) {}

  async migrateIfNeeded(): Promise<{ migratedWorkspaces: number; skipped: boolean }> {
    try {
      const status = await this.readStatus();
      if (status && status.version >= TRACE_SCHEMA_VERSION) {
        // Schema already up-to-date - silently skip
        return { migratedWorkspaces: 0, skipped: true };
      }

      // Starting trace schema migration
      const workspaceIds = await this.fileSystem.listWorkspaceIds();
      let migratedCount = 0;

      for (const workspaceId of workspaceIds) {
        const workspace = await this.fileSystem.readWorkspace(workspaceId);
        if (!workspace) continue;

        let workspaceUpdated = false;

        for (const session of Object.values(workspace.sessions)) {
          for (const trace of Object.values(session.memoryTraces)) {
            if (trace.metadata && (trace.metadata as any).schemaVersion >= TRACE_SCHEMA_VERSION) {
              continue;
            }

            const normalized = normalizeLegacyTraceMetadata({
              workspaceId: workspace.id,
              sessionId: session.id,
              traceType: trace.type,
              metadata: trace.metadata
            });

            if (normalized) {
              trace.metadata = normalized;
              workspaceUpdated = true;
            }
          }
        }

        if (workspaceUpdated) {
          await this.createBackup(workspaceId);
          await this.fileSystem.writeWorkspace(workspaceId, workspace);
          migratedCount++;
        }
      }

      await this.writeStatus({
        version: TRACE_SCHEMA_VERSION,
        migratedAt: Date.now()
      });

      return { migratedWorkspaces: migratedCount, skipped: false };
    } catch (error) {
      console.error('[TraceSchemaMigrationService] Migration failed:', error);
      return { migratedWorkspaces: 0, skipped: false };
    }
  }

  private async readStatus(): Promise<TraceSchemaStatus | null> {
    try {
      const content = await this.vaultOperations.readFile(this.markerPath);
      if (!content) {
        return null;
      }
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async writeStatus(status: TraceSchemaStatus): Promise<void> {
    const json = JSON.stringify(status, null, 2);
    await this.vaultOperations.writeFile(this.markerPath, json);
  }

  private async ensureBackupsDir(): Promise<void> {
    await this.vaultOperations.ensureDirectory(this.backupsPath);
  }

  private async createBackup(workspaceId: string): Promise<void> {
    try {
      const filePath = normalizePath(`${this.workspacesPath}/${workspaceId}.json`);
      const content = await this.vaultOperations.readFile(filePath);
      if (!content) {
        return;
      }

      await this.ensureBackupsDir();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = normalizePath(`${this.backupsPath}/${workspaceId}-${timestamp}.json.bak`);
      await this.vaultOperations.writeFile(backupPath, content);
    } catch (error) {
      console.error(`[TraceSchemaMigration] Failed to backup workspace ${workspaceId}:`, error);
    }
  }
}
