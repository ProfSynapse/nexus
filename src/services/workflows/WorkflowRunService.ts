import type { App, Plugin, WorkspaceLeaf } from 'obsidian';
import { generateSessionId } from '../../utils/sessionUtils';
import { ModelSelectionUtility } from '../../ui/chat/utils/ModelSelectionUtility';
import { WorkspaceIntegrationService } from '../../ui/chat/services/WorkspaceIntegrationService';
import { SystemPromptBuilder } from '../../ui/chat/services/SystemPromptBuilder';
import type { ChatService } from '../chat/ChatService';
import type { WorkspaceService } from '../WorkspaceService';
import type { CustomPromptStorageService } from '../../agents/promptManager/services/CustomPromptStorageService';
import type { PreparedWorkflow, SessionWorkflowPort } from '../instructions/types';
import type { WorkflowPreparationService } from './WorkflowPreparationService';
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
  workflowPreparation: WorkflowPreparationService;
  sessionWorkflows: SessionWorkflowPort;
}

interface WorkflowModelOption {
  providerId?: string;
  modelId?: string;
  contextWindow: number;
}

export class WorkflowRunService {
  private workspaceIntegration: WorkspaceIntegrationService;
  private systemPromptBuilder: SystemPromptBuilder;

  constructor(private deps: WorkflowRunServiceDeps) {
    this.workspaceIntegration = new WorkspaceIntegrationService(deps.app);
    this.systemPromptBuilder = new SystemPromptBuilder(
      this.workspaceIntegration.readNoteContent.bind(this.workspaceIntegration),
      this.workspaceIntegration.loadWorkspace.bind(this.workspaceIntegration),
      this.workspaceIntegration.getBuiltInDocsWorkspaceInfo.bind(this.workspaceIntegration)
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
    const model = await this.resolveDefaultModel();
    if (!model) throw new Error('Select an available model before running a workflow');
    const basePrompt = await this.buildSystemPrompt({ sessionId, workspaceId: request.workspaceId, customPrompt: null, loadedWorkspaceData, providerId: model.providerId });
    const prepared = await this.deps.workflowPreparation.prepare(workspace, workflow.id, { maxTokens: Math.max(0, model.contextWindow - 2048 - Math.ceil((basePrompt?.length ?? 0) / 4)) });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const systemPrompt = await this.buildSystemPrompt({
      sessionId,
      workspaceId: request.workspaceId,
      customPrompt: null,
      preparedWorkflow: prepared.value,
      loadedWorkspaceData,
      providerId: model?.providerId
    });
    const kickoffMessage = buildWorkflowKickoffMessage(workflow, runTrigger, scheduledFor);
    if (Math.ceil(((systemPrompt?.length ?? 0) + kickoffMessage.length) / 4) > model.contextWindow - 2048) throw new Error('Workflow instructions and kickoff exceed this model context budget. Choose a larger model or reduce the workflow.');
    const activated = await this.deps.sessionWorkflows.commit(sessionId, request.workspaceId, prepared.value, this.deps.sessionWorkflows.begin(sessionId, request.workspaceId));
    if (!activated.ok) throw new Error(activated.error.message);

    const result = await this.deps.chatService.createConversation(
      buildWorkflowRunTitle(workspace.name, workflow.name, scheduledFor),
      undefined,
      {
        provider: model?.providerId,
        model: model?.modelId,
        systemPrompt: systemPrompt || undefined,
        workspaceId: request.workspaceId,
        sessionId,
        // Run provenance does not overwrite the independently chosen chat prompt.
        promptId: undefined,
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
        sessionId,
        operationOrigin: 'workflow',
        operationScopeId: runKey,
      });

      if (!startedInChat) {
        const sendResult = await this.deps.chatService.sendMessage(result.conversationId, kickoffMessage, {
          provider: model?.providerId,
          model: model?.modelId,
          systemPrompt: systemPrompt || undefined,
          workspaceId: request.workspaceId,
          sessionId,
          operationOrigin: 'workflow',
          operationScopeId: runKey,
        });
        if (!sendResult.success) throw new Error(sendResult.error || 'Workflow run failed');
      }
    } else {
      const sendResult = await this.deps.chatService.sendMessage(result.conversationId, kickoffMessage, {
        provider: model?.providerId,
        model: model?.modelId,
        systemPrompt: systemPrompt || undefined,
        workspaceId: request.workspaceId,
        sessionId,
        operationOrigin: 'workflow',
        operationScopeId: runKey,
      });
      if (!sendResult.success) throw new Error(sendResult.error || 'Workflow run failed');
    }

    return {
      conversationId: result.conversationId,
      sessionId: result.sessionId
    };
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
    preparedWorkflow?: PreparedWorkflow;
  }): Promise<string | null> {
    return this.systemPromptBuilder.build({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      customPrompt: params.customPrompt,
      preparedWorkflow: params.preparedWorkflow,
      loadedWorkspaceData: params.loadedWorkspaceData,
      skipToolsSection: params.providerId === 'webllm'
    });
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
      operationOrigin?: import('../../types/tools/ToolOperationTypes').ToolExecutionOrigin;
      operationScopeId?: string;
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
      operationOrigin?: import('../../types/tools/ToolOperationTypes').ToolExecutionOrigin;
      operationScopeId?: string;
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
            operationOrigin?: import('../../types/tools/ToolOperationTypes').ToolExecutionOrigin;
            operationScopeId?: string;
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
      await new Promise(resolve => window.setTimeout(resolve, 200));
    }

    return false;
  }
}
