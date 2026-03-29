import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { generateSessionId } from '../../utils/sessionUtils';
import { ModelSelectionUtility } from '../../ui/chat/utils/ModelSelectionUtility';
import { WorkspaceIntegrationService } from '../../ui/chat/services/WorkspaceIntegrationService';
import { SystemPromptBuilder, type PromptSummary, type ToolAgentInfo } from '../../ui/chat/services/SystemPromptBuilder';
import type { ChatService } from '../chat/ChatService';
import type { WorkspaceService } from '../WorkspaceService';
import type { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
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

  private resolvePrompt(promptId?: string) {
    if (!promptId || !this.deps.customPromptStorage) {
      return undefined;
    }
    return this.deps.customPromptStorage.getPromptByNameOrId(promptId);
  }

  private async resolveDefaultModel() {
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
      toolAgents: await this.getToolAgentInfo(),
      skipToolsSection: params.providerId === 'webllm'
    });
  }

  private async getToolAgentInfo(): Promise<ToolAgentInfo[]> {
    const plugin = this.deps.plugin as Plugin & {
      serviceManager?: { getServiceIfReady?: (name: string) => any };
      connector?: { agentRegistry?: { getAllAgents: () => Map<string, any> } };
    };

    const agentService = plugin.serviceManager?.getServiceIfReady?.('agentRegistrationService');
    if (agentService) {
      const agents = agentService.getAllAgents();
      const agentMap = agents instanceof Map ? agents : new Map(agents.map((agent: { name: string }) => [agent.name, agent]));
      return Array.from(agentMap.entries()).map(([name, agent]: [string, any]) => ({
        name,
        description: agent.description || '',
        tools: (agent.getTools?.() || []).map((tool: { slug?: string; name?: string }) => tool.slug || tool.name || 'unknown')
      }));
    }

    const agents = plugin.connector?.agentRegistry?.getAllAgents?.();
    if (!agents) {
      return [];
    }

    return Array.from(agents.entries()).map(([name, agent]: [string, any]) => ({
      name,
      description: agent.description || '',
      tools: (agent.getTools?.() || []).map((tool: { slug?: string; name?: string }) => tool.slug || tool.name || 'unknown')
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

    this.deps.app.workspace.revealLeaf(leaf);
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
