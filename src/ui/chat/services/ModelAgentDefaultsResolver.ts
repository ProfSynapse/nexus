import type { App } from 'obsidian';
import type NexusPlugin from '../../../main';
import { StaticModelsService } from '../../../services/StaticModelsService';
import type { ThinkingSettings } from '../../../types/llm/ProviderTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import type { ModelOption, PromptOption } from '../types/SelectionTypes';
import type { ModelAgentWorkspaceContextService, ModelAgentWorkspaceState } from './ModelAgentWorkspaceContextService';

interface PluginWithSettings {
  settings?: {
    settings?: {
      llmProviders?: {
        defaultThinking?: ThinkingSettings;
        defaultTemperature?: number;
        agentModel?: { provider: string; model: string };
        agentThinking?: ThinkingSettings;
      };
      defaultWorkspaceId?: string;
      defaultPromptId?: string;
      defaultContextNotes?: string[];
    };
  };
}

export interface ModelAgentDefaultState {
  selectedModel: ModelOption | null;
  selectedPrompt: PromptOption | null;
  currentSystemPrompt: string | null;
  workspaceState: ModelAgentWorkspaceState;
  contextNotes: string[];
  thinkingSettings: ThinkingSettings;
  agentProvider: string | null;
  agentModel: string | null;
  agentThinkingSettings: ThinkingSettings;
  temperature: number;
}

interface ModelAgentDefaultsResolverDependencies {
  app: App;
  staticModelsService?: Pick<StaticModelsService, 'findModel'>;
  workspaceContextService: Pick<ModelAgentWorkspaceContextService, 'restoreWorkspace' | 'createEmptyState'>;
  getAvailableModels: () => Promise<ModelOption[]>;
  getAvailablePrompts: () => Promise<PromptOption[]>;
  getPlugin?: () => PluginWithSettings | null;
}

export class ModelAgentDefaultsResolver {
  private readonly staticModelsService: Pick<StaticModelsService, 'findModel'>;

  constructor(private readonly deps: ModelAgentDefaultsResolverDependencies) {
    this.staticModelsService = deps.staticModelsService ?? StaticModelsService.getInstance();
  }

  async resolveDefaultState(): Promise<ModelAgentDefaultState> {
    const availableModels = await this.deps.getAvailableModels();
    const selectedModel = await ModelSelectionUtility.findDefaultModelOption(this.deps.app, availableModels);

    const plugin = this.getPlugin();
    const settings = plugin?.settings?.settings;
    const llmProviders = settings?.llmProviders;

    const thinkingSettings: ThinkingSettings = {
      enabled: llmProviders?.defaultThinking?.enabled ?? false,
      effort: llmProviders?.defaultThinking?.effort ?? 'medium'
    };

    const agentThinkingSettings: ThinkingSettings = {
      enabled: llmProviders?.agentThinking?.enabled ?? false,
      effort: llmProviders?.agentThinking?.effort ?? 'medium'
    };

    const workspaceState = settings?.defaultWorkspaceId
      ? await this.deps.workspaceContextService.restoreWorkspace(settings.defaultWorkspaceId, undefined)
      : this.deps.workspaceContextService.createEmptyState();

    let selectedPrompt: PromptOption | null = null;
    if (settings?.defaultPromptId) {
      const availablePrompts = await this.deps.getAvailablePrompts();
      selectedPrompt = availablePrompts.find(
        prompt => prompt.id === settings.defaultPromptId || prompt.name === settings.defaultPromptId
      ) ?? null;
    }

    return {
      selectedModel,
      selectedPrompt,
      currentSystemPrompt: selectedPrompt?.systemPrompt ?? null,
      workspaceState,
      contextNotes: Array.isArray(settings?.defaultContextNotes) ? settings.defaultContextNotes : [],
      thinkingSettings,
      agentProvider: llmProviders?.agentModel?.provider || null,
      agentModel: llmProviders?.agentModel?.model || null,
      agentThinkingSettings,
      temperature: llmProviders?.defaultTemperature ?? 0.5
    };
  }

  async getSelectedModelOrDefault(selectedModel: ModelOption | null): Promise<ModelOption | null> {
    if (selectedModel) {
      return selectedModel;
    }

    const availableModels = await this.deps.getAvailableModels();
    return await ModelSelectionUtility.findDefaultModelOption(this.deps.app, availableModels);
  }

  async resolveModelOption(providerId: string, modelId: string): Promise<ModelOption | null> {
    if (!providerId || !modelId) {
      return null;
    }

    const availableModels = await this.deps.getAvailableModels();
    const discoveredModel = availableModels.find(
      model => model.providerId === providerId && model.modelId === modelId
    );
    if (discoveredModel) {
      return discoveredModel;
    }

    const staticModel = this.staticModelsService.findModel(providerId, modelId);
    if (staticModel) {
      return {
        providerId,
        providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
        modelId,
        modelName: staticModel.name,
        contextWindow: staticModel.contextWindow,
        supportsThinking: staticModel.capabilities.supportsThinking
      };
    }

    return {
      providerId,
      providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
      modelId,
      modelName: modelId,
      contextWindow: 128000,
      supportsThinking: false
    };
  }

  private getPlugin(): PluginWithSettings | null {
    if (this.deps.getPlugin) {
      return this.deps.getPlugin();
    }

    return getNexusPlugin<NexusPlugin>(this.deps.app) as unknown as PluginWithSettings | null;
  }
}
