/**
 * Location: /src/ui/chat/services/WorkspaceIntegrationService.ts
 *
 * Purpose: Handles workspace loading, session binding, and dynamic context retrieval
 * Extracted from ModelAgentManager.ts to follow Single Responsibility Principle
 *
 * Used by: ModelAgentManager for workspace operations and dynamic context
 * Dependencies: WorkspaceService, SessionContextManager, Obsidian Vault API
 */

import { App, TFile, TFolder } from 'obsidian';
import type { BuiltInDocsWorkspaceInfo, VaultStructure, WorkspaceSummary } from './SystemPromptBuilder';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type NexusPlugin from '../../../main';
import type { WorkspaceService } from '../../../services/WorkspaceService';
import type { SessionContextManager } from '../../../services/SessionContextManager';
import { WorkspaceSummaryService } from '../../../services/workspace/WorkspaceSummaryService';
import type { SkillService } from '../../../services/skills/SkillService';
import type { CliToolSchema } from '../../../agents/toolManager/types';
import { MemoryManagerAgent } from '../../../agents/memoryManager/memoryManager';
import { WorkspaceLoadService, type WorkspaceLoadValidation } from '../../../services/workspace/WorkspaceLoadService';
import type { WorkflowPreparationService, WorkflowPreparationBudget } from '../../../services/workflows/WorkflowPreparationService';
import type { SessionWorkflowPort, PreparedWorkflow, PreparedInstruction, ServiceResult, ToolCatalogPort } from '../../../services/instructions/types';
import type { AgentManager } from '../../../services/AgentManager';

/**
 * Service for workspace integration with chat
 */
export class WorkspaceIntegrationService {
  constructor(private app: App) {}

  /** A passive briefing read never selects a workflow or updates session bindings. */
  async loadWorkspace(workspaceId: string): Promise<Record<string, unknown> | null> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const agents = await plugin?.getService<AgentManager>('agentManager');
    const memory = agents?.getAgent('memoryManager');
    if (!(memory instanceof MemoryManagerAgent)) return null;
    const result = await memory.readWorkspaceBriefing({ workspace: workspaceId, limit: 3, context: { workspaceId, sessionId: '', memory: 'Reading workspace context', goal: 'Refresh workspace briefing without changing selection' } });
    return result.success ? { id: result.workspaceContext?.workspaceId ?? workspaceId, ...result.data, workspaceContext: result.workspaceContext } : null;
  }

  async activateWorkspace(workspaceId: string, sessionId: string, workflow?: string, budget?: WorkflowPreparationBudget, validate?: WorkspaceLoadValidation): Promise<Record<string, unknown>> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    if (!plugin) throw new Error('Nexus is unavailable');
    const [agents, preparation, activation] = await Promise.all([
      plugin.getService<AgentManager>('agentManager'),
      plugin.getService<WorkflowPreparationService>('workflowPreparationService'),
      plugin.getService<SessionWorkflowPort>('sessionWorkflowService'),
    ]);
    const memory = agents?.getAgent('memoryManager');
    if (!(memory instanceof MemoryManagerAgent) || !preparation || !activation) throw new Error('Workspace services are initializing');
    const adjustedBudget = { ...budget };
    const loader = new WorkspaceLoadService(async params => {
      const result = await memory.readWorkspaceBriefing(params);
      if (result.success && adjustedBudget.maxTokens !== undefined) {
        const briefing = { ...result.data };
        delete briefing.workflowDefinitions; delete briefing.loadedWorkflow; delete briefing.preloadedTools; delete briefing.prompt;
        const remaining = Math.max(0, adjustedBudget.maxTokens - Math.ceil(JSON.stringify(briefing).length / 4));
        adjustedBudget.maxTokens = remaining;
      }
      return result;
    }, preparation, activation, validate);
    const result = await loader.load({ workspace: workspaceId, ...(workflow ? { workflow } : {}), limit: 3,
      context: { workspaceId, sessionId, memory: 'Selecting chat workspace instructions', goal: 'Prepare the selected workspace and optional workflow' } }, adjustedBudget);
    if (!result.success) throw new Error(result.error || 'Workspace could not be loaded');
    return { id: result.workspaceContext?.workspaceId ?? workspaceId, ...result.data, workspaceContext: result.workspaceContext };
  }

  async restoreWorkflow(sessionId: string): Promise<ServiceResult<PreparedWorkflow | null>> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const activation = await plugin?.getService<SessionWorkflowPort>('sessionWorkflowService');
    if (!plugin) return { ok: true, value: null };
    return activation ? activation.restore(sessionId) : { ok: false, error: { code: 'initializing', message: 'Workflow services are initializing' } };
  }

  async prepareIndividualSkills(sessionId: string, workflow: PreparedWorkflow | null): Promise<{ skills: PreparedInstruction[]; tools: CliToolSchema[] }> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const sessions = await plugin?.getService<SessionContextManager>('sessionContextManager');
    const managed = new Set(workflow?.skills.map(skill => skill.reference.type === 'skill' ? `${skill.reference.provider}/${skill.reference.name}` : '') ?? []);
    const ids = (sessions?.getIndividuallyLoadedSkills(sessionId) ?? []).filter(id => !managed.has(id));
    if (!ids.length) return { skills: [], tools: [] };
    const [skillsService, catalog] = await Promise.all([
      plugin?.getService<SkillService>('skillService'), plugin?.getService<ToolCatalogPort>('toolCatalogService'),
    ]);
    if (!skillsService || !catalog) throw new Error('Loaded skill services are initializing');
    const references = ids.map(id => { const slash = id.indexOf('/'); return { provider: id.slice(0, slash), name: id.slice(slash + 1) }; });
    const prepared = await skillsService.prepareMany(references);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const tools = catalog.resolve([...new Set(prepared.value.flatMap(skill => skill.toolSelectors))]);
    if (!tools.ok) throw new Error(tools.error.message);
    return { skills: prepared.value, tools: tools.value };
  }

  async getBoundWorkspace(sessionId: string): Promise<string | undefined> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const sessions = await plugin?.getService<SessionContextManager>('sessionContextManager');
    await sessions?.ensureBindingsRestored();
    return sessions?.resolveHandleWorkspace(sessionId);
  }

  async getSelectedWorkflowId(sessionId: string): Promise<string | null> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const [sessions, activation] = await Promise.all([
      plugin?.getService<SessionContextManager>('sessionContextManager'), plugin?.getService<SessionWorkflowPort>('sessionWorkflowService'),
    ]);
    await sessions?.ensureBindingsRestored();
    return activation?.getSelection(sessionId)?.workflowId ?? null;
  }

  async clearWorkflowSelection(sessionId: string): Promise<void> {
    const plugin = getNexusPlugin<NexusPlugin>(this.app);
    const activation = await plugin?.getService<SessionWorkflowPort>('sessionWorkflowService');
    if (!activation) throw new Error('Workflow selection service is initializing');
    const result = await activation.commit(sessionId, 'default', null, activation.begin(sessionId, 'default'));
    if (!result.ok) throw new Error(result.error.message);
  }

  /**
   * Read note content from vault
   */
  async readNoteContent(notePath: string): Promise<string> {
    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);

      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        return content;
      }

      return '[File not found]';
    } catch {
      return '[Error reading file]';
    }
  }

  /**
   * Bind a session to a workspace in SessionContextManager
   */
  async bindSessionToWorkspace(sessionId: string | undefined, workspaceId: string): Promise<void> {
    if (!sessionId) {
      return;
    }

    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return;
      }

      const sessionContextManager = await plugin.getService<SessionContextManager>('sessionContextManager');

      if (sessionContextManager) {
        sessionContextManager.setWorkspaceContext(sessionId, {
          workspaceId: workspaceId,
          activeWorkspace: true
        });
      }
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to bind session to workspace:', error);
    }
  }

  /**
   * Get the root-level vault structure (folders and files)
   * Used to give the LLM awareness of the vault's organization
   */
  getVaultStructure(): VaultStructure {
    const rootFolders: string[] = [];
    const rootFiles: string[] = [];

    try {
      const root = this.app.vault.getRoot();

      if (root && root.children) {
        for (const child of root.children) {
          if (child instanceof TFolder) {
            // Skip hidden folders (starting with .)
            if (!child.name.startsWith('.')) {
              rootFolders.push(child.name);
            }
          } else if (child instanceof TFile) {
            // Skip hidden files (starting with .)
            if (!child.name.startsWith('.')) {
              rootFiles.push(child.name);
            }
          }
        }
      }

      // Sort alphabetically for consistent presentation
      rootFolders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      rootFiles.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to get vault structure:', error);
    }

    return { rootFolders, rootFiles };
  }

  /**
   * Get all available workspaces with summary information
   * Used to give the LLM awareness of what workspaces exist
   */
  async listAvailableWorkspaces(): Promise<WorkspaceSummary[]> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return [];
      }

      const workspaceService = await plugin.getService<WorkspaceService>('workspaceService');

      if (!workspaceService) {
        return [];
      }

      // Use listWorkspaces for lightweight index-based listing
      const workspaces = await workspaceService.listWorkspaceDiscovery();

      return workspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        description: ws.description || undefined,
        rootFolder: ws.rootFolder || '/',
        workflows: new WorkspaceSummaryService().summarize(ws).workflows
      }));
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to list workspaces:', error);
      return [];
    }
  }

  async getBuiltInDocsWorkspaceInfo(): Promise<BuiltInDocsWorkspaceInfo | null> {
    try {
      const plugin = getNexusPlugin<NexusPlugin>(this.app);
      if (!plugin) {
        return null;
      }

      const workspaceService = await plugin.getService<WorkspaceService>('workspaceService');
      if (!workspaceService) {
        return null;
      }

      const summary = workspaceService.getSystemGuidesWorkspaceSummary();
      if (!summary) {
        return null;
      }

      return {
        id: summary.id,
        name: summary.name,
        description: summary.description,
        rootFolder: summary.rootFolder,
        entrypoint: summary.entrypoint
      };
    } catch (error) {
      console.error('[WorkspaceIntegrationService] Failed to get built-in docs workspace:', error);
      return null;
    }
  }
}
