/**
 * Fixtures for tests that render the full settings layout.
 *
 * Test files wire these in with jest.mock factories, for example:
 *
 *   jest.mock('../../src/services/llm/providers/ProviderManager', () =>
 *     jest.requireActual('../helpers/settingsRendererFixtures').providerManagerModule());
 *
 * The model table mirrors the registry facts the layout depends on: which
 * models reason (Thinking row), which reject temperature (Creativity row),
 * their context windows (Context window row and summaries) and display names
 * (summaries). Tests about capabilities themselves use the real registry.
 */
import type { ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

export interface FixtureModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  supportsThinking: boolean;
  /** False when the registry says the model rejects temperature. */
  supportsSamplingParams?: boolean;
}

export const FIXTURE_MODELS: FixtureModel[] = [
  { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, supportsThinking: true, supportsSamplingParams: false },
  { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: 1_000_000, supportsThinking: true, supportsSamplingParams: false },
  { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200_000, supportsThinking: true },
  { provider: 'mistral', id: 'mistral-large-latest', name: 'Mistral Large Latest', contextWindow: 128_000, supportsThinking: false },
  { provider: 'mistral', id: 'magistral-medium-latest', name: 'Magistral Medium', contextWindow: 40_000, supportsThinking: true },
  // A small local model: below the smallest Context window preset.
  { provider: 'lmstudio', id: 'tiny-local', name: 'Tiny Local', contextWindow: 4096, supportsThinking: false }
];

export function providerManagerModule() {
  return {
    LLMProviderManager: jest.fn().mockImplementation(() => ({
      getModelsForProvider: jest.fn(async (provider: string) => FIXTURE_MODELS
        .filter(model => model.provider === provider)
        .map(model => ({ ...model, capabilities: { supportsThinking: model.supportsThinking } }))),
      updateSettings: jest.fn()
    }))
  };
}

export function staticModelsModule() {
  const service = {
    findModel: jest.fn((provider: string, id: string) => {
      const model = FIXTURE_MODELS.find(item => item.provider === provider && item.id === id);
      return model ? { ...model, capabilities: { supportsThinking: model.supportsThinking } } : undefined;
    }),
    getModelsForProvider: jest.fn(() => [])
  };
  return { StaticModelsService: { getInstance: jest.fn(() => service) } };
}

export function imageServiceModule() {
  return {
    ImageGenerationService: jest.fn().mockImplementation(() => ({
      getModelsForProvider: jest.fn(async (provider: string) => provider === 'google'
        ? [{ id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' }]
        : [{ id: `${provider}-image`, name: `${provider} image` }]),
      updateSettings: jest.fn()
    }))
  };
}

export function ingestCapabilityModule() {
  const actual = jest.requireActual('../../src/agents/ingestManager/tools/services/IngestCapabilityService');
  return {
    ...actual,
    getIngestCapabilityOptions: jest.fn(async () => ({
      ocrProviders: [{ id: 'google', name: 'Google AI', models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash' }] }],
      transcriptionProviders: [{ id: 'deepgram', name: 'Deepgram', models: [{ id: 'nova-3', name: 'Deepgram Nova-3' }] }]
    }))
  };
}

export function llmSettings(overrides: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  return {
    providers: {
      anthropic: { enabled: true, apiKey: 'test' },
      mistral: { enabled: true, apiKey: 'test' }
    },
    defaultModel: { provider: 'anthropic', model: 'claude-opus-5-5' },
    ...overrides
  } as LLMProviderSettings;
}

export function chatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    thinking: { enabled: true, effort: 'high' },
    agentProvider: 'anthropic',
    agentModel: 'claude-haiku-5-5',
    agentThinking: { enabled: false, effort: 'medium' },
    temperature: 0.5,
    imageProvider: 'google',
    imageModel: 'gemini-3.1-flash-image',
    workspaceId: null,
    promptId: null,
    contextNotes: [],
    ...overrides
  };
}
