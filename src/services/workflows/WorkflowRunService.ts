import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { generateSessionId } from '../../utils/sessionUtils';
import { ModelSelectionUtility } from '../../ui/chat/utils/ModelSelectionUtility';
import { WorkspaceIntegrationService } from '../../ui/chat/services/WorkspaceIntegrationService';
import { SystemPromptBuilder, type PromptSummary, type ToolAgentInfo } from '../../ui/chat/services/SystemPromptBuilder';
import type { ChatService } from '../chat/ChatService';
import type { WorkspaceService } from '../WorkspaceService';
import type { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import type { CustomPrompt } from '../../types';
import type { WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import {
  buildWorkflowKickoffMessage,
  buildWorkflowRunTitle,
  type WorkflowRunRequest,
  type WorkflowRunResult
} from './types';

export interface WorkflowRunServiceDeps {
  app: App;
  plugin: Plugin;
  chatService: ChatService;
  workspaceService: WorkspaceService;
  customPromptStorage?: CustomPromptStorageService | null;
}

interface WorkflowModelOption {
  providerId?: string;
  modelId?: string;
}

interface AgentToolInfo {
  slug?: string;
  name?: string;
}

interface AgentLike {
  name?: string;
  description?: string;
  getTools?: () => AgentToolInfo[];
}

interface AgentRegistryLike {
  getAllAgents: () => Map<string, AgentLike> | AgentLike[] | Array<[string, AgentLike]>;
}

interface PluginWithAgentRegistry extends Plugin {
  serviceManager?: {
    getServiceIfReady?: (name: string) => AgentRegistryLike | null | undefined;
  };
  connector?: {
    agentRegistry?: {
      getAllAgents: () => Map<string, AgentLike> | AgentLike[] | Array<[string, AgentLike]>;
    };
  };
}

export class WorkflowRunService {
  private workspaceIntegration: WorkspaceIntegrationService;
  private systemPromptBuilder: SystemPromptBuilder;

  constructor(private deps: WorkflowRunServiceDeps) {
    this.workspaceIntegration = new WorkspaceIntegrationService(deps.app);
    this.systemPromptBuilder = new SystemPromptBuilder(
      this.workspaceIntegration.readNoteContent.bind(this.workspaceIntegration),
      this.workspaceIntegration.loadWorkspace.bind(this.workspaceIntegration)
    );
  }

  async start(request: WorkflowRunRequest): Promise<WorkflowRunResult> {
    const workspace = await this.deps.workspaceService.getWorkspace(request.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${request.workspaceId}`);
    }

    const loadedWorkspaceData = await this.workspaceIntegration.loadWorkspace(request.workspaceId);
    if (!loadedWorkspaceData) {
      throw new Error(`Failed to load workspace context for ${request.workspaceId}`);
    }

    const workflow = this.findWorkflowDefinition(loadedWorkspaceData, request.workflowId) ??
      workspace.context?.workflows?.find(item => item.id === request.workflowId);

    if (!workflow) {
      throw new Error(`Workflow not found: ${request.workflowId}`);
    }

    const scheduledFor = request.scheduledFor ?? Date.now();
    const runTrigger = request.runTrigger ?? 'manual';
    const runKey = request.runKey ?? `${request.workspaceId}:${workflow.id}:${scheduledFor}`;
    const sessionId = generateSessionId();
    const prompt = this.resolvePrompt(workflow.promptId);
    const model = await this.resolveDefaultModel();
    const systemPrompt = await this.buildSystemPrompt({
      sessionId,
      workspaceId: request.workspaceId,
      customPrompt: prompt?.prompt ?? null,
      loadedWorkspaceData,
      providerId: model?.providerId
    });
    const kickoffMessage = buildWorkflowKickoffMessage(workflow, runTrigger, scheduledFor);

    const result = await this.deps.chatService.createConversation(
      buildWorkflowRunTitle(workspace.name, workflow.name, scheduledFor),
      undefined,
      {
        provider: model?.providerId,
        model: model?.modelId,
        systemPrompt: systemPrompt || undefined,
        workspaceId: request.workspaceId,
        sessionId,
        promptId: workflow.promptId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        runTrigger,
        scheduledFor,
        runKey
      }
    );

    if (!result.success || !result.conversationId) {
      throw new Error(result.error || 'Failed to create workflow run conversation');
    }

    if (request.openInChat !== false) {
      const startedInChat = await this.openConversationInChat(result.conversationId, kickoffMessage, {
        provider: model?.providerId,
        model: model?.modelId,
        systemPrompt: systemPrompt || undefined,
        workspaceId: request.workspaceId,
        sessionId
      });

      if (!startedInChat) {
        await this.deps.chatService.sendMessage(result.conversationId, kickoffMessage, {
          provider: model?.providerId,
          model: model?.modelId,
          systemPrompt: systemPrompt || undefined,
          workspaceId: request.workspaceId,
          sessionId
        });
      }
    } else {
      await this.deps.chatService.sendMessage(result.conversationId, kickoffMessage, {
        provider: model?.providerId,
        model: model?.modelId,
        systemPrompt: systemPrompt || undefined,
        workspaceId: request.workspaceId,
        sessionId
      });
    }

    return {
      conversationId: result.conversationId,
      sessionId: result.sessionId
    };
  }

  private resolvePrompt(promptId?: string): CustomPrompt | undefined {
    if (!promptId || !this.deps.customPromptStorage) {
      return undefined;
    }
    return this.deps.customPromptStorage.getPromptByNameOrId(promptId);
  }

  private async resolveDefaultModel(): Promise<WorkflowModelOption | null> {
    const availableModels = await ModelSelectionUtility.getAvailableModels(this.deps.app);
    if (availableModels.length === 0) {
      return null;
    }
    return await ModelSelectionUtility.findDefaultModelOption(this.deps.app, availableModels) || availableModels[0];
  }

  private async buildSystemPrompt(params: {
    sessionId: string;
    workspaceId: string;
    customPrompt: string | null;
    loadedWorkspaceData: Record<string, unknown>;
    providerId?: string;
  }): Promise<string | null> {
    const availablePrompts: PromptSummary[] = (this.deps.customPromptStorage?.getEnabledPrompts() || []).map(prompt => ({
      id: prompt.id,
      name: prompt.name,
      description: prompt.description || 'Custom prompt'
    }));

    return this.systemPromptBuilder.build({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      customPrompt: params.customPrompt,
      loadedWorkspaceData: params.loadedWorkspaceData,
      vaultStructure: this.workspaceIntegration.getVaultStructure(),
      availableWorkspaces: await this.workspaceIntegration.listAvailableWorkspaces(),
      availablePrompts,
      toolAgents: this.getToolAgentInfo(),
      skipToolsSection: params.providerId === 'webllm'
    });
  }

  private getToolAgentInfo(): ToolAgentInfo[] {
    const plugin = this.deps.plugin as PluginWithAgentRegistry;

    const normalizeAgents = (
      agents: Map<string, AgentLike> | AgentLike[] | Array<[string, AgentLike]>
    ): Map<string, AgentLike> => {
      if (agents instanceof Map) {
        return agents;
      }

      if (agents.length > 0 && Array.isArray(agents[0])) {
        return new Map(agents as Array<[string, AgentLike]>);
      }

      const normalized = new Map<string, AgentLike>();
      for (const agent of agents as AgentLike[]) {
        if (agent.name) {
          normalized.set(agent.name, agent);
        }
      }
      return normalized;
    };

    const agentService = plugin.serviceManager?.getServiceIfReady?.('agentRegistrationService');
    if (agentService) {
      const agentMap = normalizeAgents(agentService.getAllAgents());
      return Array.from(agentMap.entries()).map(([name, agent]) => ({
        name,
        description: agent.description || '',
        tools: (agent.getTools?.() || []).map(tool => tool.slug || tool.name || 'unknown')
      }));
    }

    const agents = plugin.connector?.agentRegistry?.getAllAgents?.();
    if (!agents) {
      return [];
    }

    const agentMap = normalizeAgents(agents);
    return Array.from(agentMap.entries()).map(([name, agent]) => ({
      name,
      description: agent.description || '',
      tools: (agent.getTools?.() || []).map(tool => tool.slug || tool.name || 'unknown')
    }));
  }

  private findWorkflowDefinition(loadedWorkspaceData: Record<string, unknown>, workflowId: string): WorkspaceWorkflow | undefined {
    const workflowDefinitions = Array.isArray(loadedWorkspaceData.workflowDefinitions)
      ? loadedWorkspaceData.workflowDefinitions as WorkspaceWorkflow[]
      : [];
    return workflowDefinitions.find(workflow => workflow.id === workflowId);
  }

  private async openConversationInChat(
    conversationId: string,
    kickoffMessage: string,
    options: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<boolean> {
    const { CHAT_VIEW_TYPE } = await import('../../ui/chat/ChatView');

    let leaf: WorkspaceLeaf | null = this.deps.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.deps.app.workspace.getRightLeaf(false);
      if (!leaf) {
        return false;
      }

      await leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        active: true
      });
    }

    await this.deps.app.workspace.revealLeaf(leaf);
    return await this.waitForChatViewReady(leaf, conversationId, kickoffMessage, options);
  }

  private async waitForChatViewReady(
    leaf: WorkspaceLeaf,
    conversationId: string,
    kickoffMessage: string,
    options: {
      provider?: string;
      model?: string;
      systemPrompt?: string;
      workspaceId?: string;
      sessionId?: string;
    }
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const view = leaf.view as {
        sendMessageToConversation?: (
          id: string,
          message: string,
          viewOptions?: {
            provider?: string;
            model?: string;
            systemPrompt?: string;
            workspaceId?: string;
            sessionId?: string;
          }
        ) => Promise<void>;
        openConversationById?: (id: string) => Promise<void>;
      };
      if (typeof view.sendMessageToConversation === 'function') {
        await view.sendMessageToConversation(conversationId, kickoffMessage, options);
        return true;
      }
      if (typeof view.openConversationById === 'function') {
        await view.openConversationById(conversationId);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    return false;
  }
}
