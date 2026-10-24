import type { App } from 'obsidian';
import type NexusPlugin from '../../../main';
import { StaticModelsService } from '../../../services/StaticModelsService';
import type {
  DefaultRealtimeVoiceModelSettings,
  DefaultSpeechModelSettings,
  LLMProviderConfig,
  ThinkingSettings
} from '../../../types/llm/ProviderTypes';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { ModelSelectionUtility } from '../utils/ModelSelectionUtility';
import type { ModelOption, PromptOption } from '../types/SelectionTypes';
import type { ModelAgentWorkspaceContextService, ModelAgentWorkspaceState } from './ModelAgentWorkspaceContextService';
import { buildOpenAICompatibleModels, OPENAI_COMPATIBLE_CONTEXT_WINDOW } from '../../../services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { resolveAgentTemperature } from '../../../services/llm/utils/SubagentModelResolver';
import { getContextWindowOverrideKey } from '../utils/ContextWindowSettings';
import { DEFAULT_IMAGE_MODEL } from '../../../services/llm/types/ImageTypes';

interface PluginWithSettings {
  settings?: {
    settings?: {
      llmProviders?: {
        providers?: Record<string, LLMProviderConfig>;
        defaultThinking?: ThinkingSettings;
        defaultTemperature?: number;
        agentModel?: { provider: string; model: string };
        agentThinking?: ThinkingSettings;
        agentTemperature?: number;
        agentContextWindowOverrides?: Record<string, number>;
        defaultImageModel?: { provider: 'google' | 'openrouter' | 'openai'; model: string };
        defaultTranscriptionModel?: { provider: string; model: string };
        defaultSpeechModel?: DefaultSpeechModelSettings;
        defaultRealtimeVoiceModel?: DefaultRealtimeVoiceModelSettings;
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
  /** Subagent Creativity a new chat starts with. */
  agentTemperature: number;
  /** Subagent context budget a new chat starts with; null uses the model's default. */
  agentContextWindow: number | null;
  imageProvider: 'google' | 'openrouter' | 'openai';
  imageModel: string;
  speechProvider: DefaultSpeechModelSettings['provider'] | null;
  speechModel: DefaultSpeechModelSettings['model'] | null;
  speechVoice: DefaultSpeechModelSettings['voice'] | null;
  realtimeVoiceProvider: DefaultRealtimeVoiceModelSettings['provider'] | null;
  realtimeVoiceModel: DefaultRealtimeVoiceModelSettings['model'] | null;
  realtimeVoiceVoice: DefaultRealtimeVoiceModelSettings['voice'] | null;
  transcriptionProvider: string | null;
  transcriptionModel: string | null;
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
      agentTemperature: resolveAgentTemperature(null, llmProviders),
      agentContextWindow: this.resolveAgentContextWindowDefault(llmProviders),
      imageProvider: llmProviders?.defaultImageModel?.provider || 'google',
      imageModel: llmProviders?.defaultImageModel?.model || DEFAULT_IMAGE_MODEL,
      speechProvider: llmProviders?.defaultSpeechModel?.provider || null,
      speechModel: llmProviders?.defaultSpeechModel?.model || null,
      speechVoice: llmProviders?.defaultSpeechModel?.voice || null,
      realtimeVoiceProvider: llmProviders?.defaultRealtimeVoiceModel?.provider || null,
      realtimeVoiceModel: llmProviders?.defaultRealtimeVoiceModel?.model || null,
      realtimeVoiceVoice: llmProviders?.defaultRealtimeVoiceModel?.voice || null,
      transcriptionProvider: llmProviders?.defaultTranscriptionModel?.provider || null,
      transcriptionModel: llmProviders?.defaultTranscriptionModel?.model || null,
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

    const config = this.getPlugin()?.settings?.settings?.llmProviders?.providers?.[providerId];
    if (config?.driverKind === 'openai-compatible') {
      const model = buildOpenAICompatibleModels(config).find(candidate => candidate.id === modelId);
      return {
        providerId,
        providerName: config.openaiCompatible?.displayName || 'OpenAI-compatible',
        modelId,
        modelName: model?.name || modelId,
        contextWindow: model?.contextWindow || OPENAI_COMPATIBLE_CONTEXT_WINDOW,
        maxOutputTokens: model?.maxOutputTokens,
        supportsThinking: model?.supportsThinking ?? false
      };
    }

    const staticModel = this.staticModelsService.findModel(providerId, modelId);
    if (staticModel) {
      return {
        providerId,
        providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
        modelId,
        modelName: staticModel.name,
        contextWindow: staticModel.contextWindow,
        maxOutputTokens: staticModel.maxTokens,
        supportsThinking: staticModel.capabilities.supportsThinking
      };
    }

    return {
      providerId,
      providerName: ModelSelectionUtility.getProviderDisplayName(providerId),
      modelId,
      modelName: modelId,
      contextWindow: ['ollama', 'lmstudio', 'webllm'].includes(providerId) ? 4096 : 128000,
      supportsThinking: false
    };
  }

  /** The saved subagent limit for the default subagent model, if any. */
  private resolveAgentContextWindowDefault(
    llmProviders: { agentModel?: { provider: string; model: string }; agentContextWindowOverrides?: Record<string, number> } | undefined
  ): number | null {
    const agentModel = llmProviders?.agentModel;
    if (!agentModel?.provider || !agentModel.model) return null;
    const value = llmProviders?.agentContextWindowOverrides?.[getContextWindowOverrideKey(agentModel.provider, agentModel.model)];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  private getPlugin(): PluginWithSettings | null {
    if (this.deps.getPlugin) {
      return this.deps.getPlugin();
    }

    return getNexusPlugin<NexusPlugin>(this.deps.app);
  }
}
