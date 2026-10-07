/**
 * Failure bought: keyless named endpoints or unknown saved model IDs must not
 * disappear through builtin provider lists, share identities, or imply free pricing.
 * The LLM service mock supplies availability only; production settings and model
 * resolution decide the selected identities, visibility, names and budgets.
 */
import type { App } from 'obsidian';
import type { LLMProviderConfig, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import { LLMProviderManager } from '../../src/services/llm/providers/ProviderManager';
import { ModelSelectionUtility } from '../../src/ui/chat/utils/ModelSelectionUtility';
import { ModelAgentDefaultsResolver } from '../../src/ui/chat/services/ModelAgentDefaultsResolver';
import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';
import { buildOpenAICompatibleModels } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { getNexusPlugin } from '../../src/utils/pluginLocator';

jest.mock('../../src/services/llm/core/LLMService', () => ({
  LLMService: jest.fn().mockImplementation(() => ({
    isProviderAvailable: () => true,
    updateSettings: jest.fn()
  }))
}));
jest.mock('../../src/utils/pluginLocator', () => ({ getNexusPlugin: jest.fn() }));

const FIRST = 'openai-compatible-11111111';
const SECOND = 'openai-compatible-22222222';

function endpoint(name: string): LLMProviderConfig {
  return {
    enabled: true, apiKey: '', driverKind: 'openai-compatible',
    openaiCompatible: {
      schemaVersion: 1, displayName: name, baseUrl: 'https://endpoint.example/v1',
      models: { 'unknown-model-id': { source: 'manual' }, hidden: { source: 'discovered' } }
    },
    models: { hidden: { enabled: false } }
  };
}

function settings(): LLMProviderSettings {
  return {
    providers: { [FIRST]: endpoint('My Hermes'), [SECOND]: endpoint('Research server') },
    defaultModel: { provider: SECOND, model: 'unknown-model-id' }
  };
}

describe('OpenAI-compatible configured selection', () => {
  it('lists keyless endpoints and saved models independently, without requiring static catalog IDs', async () => {
    const manager = new LLMProviderManager(settings());
    expect(manager.getEnabledProviders().map(provider => [provider.id, provider.name])).toEqual([
      [FIRST, 'My Hermes'], [SECOND, 'Research server']
    ]);
    const models = await manager.getAvailableModels();
    expect(models.map(model => [model.provider, model.id, model.isDefault])).toEqual([
      [FIRST, 'unknown-model-id', false], [SECOND, 'unknown-model-id', true]
    ]);
    expect(models.every(model => model.contextWindow === 4096 && model.maxOutputTokens === 1024)).toBe(true);
    expect(await manager.validateProviderModel(FIRST, 'unknown-model-id')).toBe(true);
    expect(await manager.validateProviderModel(FIRST, 'hidden')).toBe(false);
    expect(await manager.getCostEstimate(FIRST, 'unknown-model-id', 1000)).toBeNull();
    expect(await manager.getModelStatistics()).toEqual(expect.objectContaining({
      minCostPerMillion: null, maxCostPerMillion: null
    }));
  });

  it('disabling one endpoint retains the other endpoint and rejects the disabled pair', async () => {
    const config = settings();
    config.providers[FIRST].enabled = false;
    const manager = new LLMProviderManager(config);
    expect(manager.getEnabledProviders().map(provider => provider.id)).toEqual([SECOND]);
    expect(await manager.validateProviderModel(FIRST, 'unknown-model-id')).toBe(false);
    expect(await manager.validateProviderModel(SECOND, 'unknown-model-id')).toBe(true);
  });

  it('maps runtime models to friendly names without losing stable IDs or default selection', async () => {
    const config = settings();
    const discovered = Object.entries(config.providers).flatMap(([provider, value]) =>
      buildOpenAICompatibleModels(value).map(model => ({ ...model, provider })));
    jest.mocked(getNexusPlugin).mockReturnValue({
      settings: { settings: { llmProviders: config } },
      getService: async () => ({ getAvailableModels: async () => discovered })
    } as unknown as ReturnType<typeof getNexusPlugin>);
    const app = {} as App;
    const options = await ModelSelectionUtility.getAvailableModels(app);
    expect(options.map(model => [model.providerId, model.providerName, model.modelId])).toEqual([
      [FIRST, 'My Hermes', 'unknown-model-id'], [SECOND, 'Research server', 'unknown-model-id']
    ]);
    expect((await ModelSelectionUtility.findDefaultModelOption(app, options))?.providerId).toBe(SECOND);
  });

  it('offers keyless custom endpoints in shared chat/default and agent provider controls', () => {
    const config = settings();
    type Availability = { getEnabledProviders(): string[] };
    const method = (ChatSettingsRenderer.prototype as unknown as Availability).getEnabledProviders;
    expect(method.call({ config: { llmProviderSettings: config } })).toEqual([FIRST, SECOND]);
    config.providers[FIRST].enabled = false;
    expect(method.call({ config: { llmProviderSettings: config } })).toEqual([SECOND]);
  });

  it('restores a saved custom selection with its conservative budget even before runtime models arrive', async () => {
    const config = settings();
    const resolver = new ModelAgentDefaultsResolver({
      app: {} as App,
      workspaceContextService: { restoreWorkspace: jest.fn(), createEmptyState: jest.fn() },
      getAvailableModels: async () => [], getAvailablePrompts: async () => [],
      getPlugin: () => ({ settings: { settings: { llmProviders: config } } })
    });
    expect(await resolver.resolveModelOption(FIRST, 'unknown-model-id')).toEqual(expect.objectContaining({
      providerId: FIRST, providerName: 'My Hermes', modelId: 'unknown-model-id', contextWindow: 4096
    }));
    expect((await resolver.resolveModelOption(FIRST, 'previous-server-model'))?.contextWindow).toBe(4096);
  });
});
