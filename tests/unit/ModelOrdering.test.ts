import { DropdownComponent, createMockElement } from 'obsidian';
import { renderModelDropdownSection } from '../../src/components/shared/ModelDropdownRenderer';
import type { LLMProviderManager } from '../../src/services/llm/providers/ProviderManager';
import { ModelRegistry } from '../../src/services/llm/adapters/ModelRegistry';
import { sortModelsNewestFirst } from '../../src/utils/modelOrdering';

const oldModel = { provider: 'anthropic', id: 'claude-haiku-4-5-20251001', name: 'Claude 4.5 Haiku' };
const newModel = { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' };
const cliModel = { provider: 'anthropic-claude-code', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' };

describe('model picker ordering', () => {
  it('sorts verified dates first, keeps unknown/equal dates stable, and leaves registry arrays untouched', () => {
    const models = [oldModel, newModel, cliModel, { provider: 'custom', id: 'local', name: 'Local' }];
    const input = [...models];
    const registryBefore = ModelRegistry.getProviderModels('anthropic').map(model => model.apiName);

    const sorted = sortModelsNewestFirst(models, model => ({ provider: model.provider, id: model.id }));

    expect(sorted).toEqual([newModel, cliModel, oldModel, models[3]]);
    expect(models).toEqual(input);
    expect(ModelRegistry.getProviderModels('anthropic').map(model => model.apiName)).toEqual(registryBefore);
  });

  it('uses a valid provider-published created timestamp only when no registry date exists', () => {
    const older = { provider: 'custom', id: 'older', created: 1700000000 };
    const newer = { provider: 'custom', id: 'newer', created: 1800000000 };
    const invalid = { provider: 'custom', id: 'invalid', created: Number.NaN };
    expect(sortModelsNewestFirst([older, invalid, newer], model => model)).toEqual([newer, older, invalid]);
  });

  it.each([
    ['saved selection', oldModel.id],
    ['unset selection', undefined],
    ['unavailable saved selection', 'claude-retired'],
  ])('orders the actual merged Anthropic dropdown while preserving %s', async (_label, selectedModel) => {
    const addOption = jest.spyOn(DropdownComponent.prototype, 'addOption');
    const setValue = jest.spyOn(DropdownComponent.prototype, 'setValue');
    const onModelChange = jest.fn();
    const providerManager = {
      getModelsForProvider: jest.fn(async (provider: string) =>
        provider === 'anthropic' ? [oldModel, newModel] : [cliModel]),
    } as unknown as LLMProviderManager;

    renderModelDropdownSection(createMockElement('div'), {
      sectionTitle: 'Chat model',
      getProviders: () => ['anthropic'],
      getCurrentProvider: () => 'anthropic',
      getCurrentModel: () => selectedModel,
      onProviderChange: jest.fn(),
      onModelChange,
      noProvidersText: 'No providers',
      modelOptionMap: new Map(),
      providerManager,
      isCodexConnected: () => false,
      isClaudeCodeConnected: () => true,
      isGeminiCliConnected: () => false,
      getDefaultModelForProvider: async () => oldModel.id,
      notifyChange: jest.fn(),
      reRender: jest.fn(),
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    const options = addOption.mock.calls.map(([key]) => key).filter(key => key.includes('::'));
    expect(options).toEqual([
      'anthropic::claude-haiku-5-5',
      'anthropic-claude-code::claude-haiku-5-5',
      'anthropic::claude-haiku-4-5-20251001',
      ...(selectedModel === 'claude-retired' ? ['anthropic::claude-retired'] : []),
    ]);
    expect(setValue).toHaveBeenCalledWith(`anthropic::${selectedModel || oldModel.id}`);
    if (selectedModel) expect(onModelChange).not.toHaveBeenCalled();
    else expect(onModelChange).toHaveBeenCalledWith(oldModel.id, 'anthropic');
    if (selectedModel === 'claude-retired') {
      expect(addOption).toHaveBeenCalledWith('anthropic::claude-retired', 'claude-retired (Unavailable)');
    }
    addOption.mockRestore();
    setValue.mockRestore();
  });
});
