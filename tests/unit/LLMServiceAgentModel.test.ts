/**
 * LLMService.getAgentModel honours the configured subagent model.
 *
 * Defect this buys: getAgentModel returned the chat default whenever it was a
 * cloud model, so the subagent model saved in Defaults only mattered for
 * local chat models. The adapter registry is mocked only for provider
 * availability; the precedence under test is the real resolver.
 */
const mockAvailableProviders: string[] = [];

jest.mock('../../src/services/llm/core/AdapterRegistry', () => ({
  AdapterRegistry: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    updateSettings: jest.fn(),
    setOnSettingsDirty: jest.fn(),
    getAdapter: jest.fn(),
    getAvailableProviders: jest.fn(() => mockAvailableProviders),
    isProviderAvailable: jest.fn((provider: string) => mockAvailableProviders.includes(provider)),
    waitForInit: jest.fn(),
    clear: jest.fn(),
  })),
}));

jest.mock('../../src/services/llm/core/ModelDiscoveryService', () => ({
  ModelDiscoveryService: jest.fn().mockImplementation(() => ({
    getAvailableModels: jest.fn(async () => []),
  })),
}));

import { LLMService } from '../../src/services/llm/core/LLMService';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

function service(settings: Partial<LLMProviderSettings>): LLMService {
  return new LLMService({ providers: {}, defaultModel: { provider: 'openai', model: 'gpt-5.4' }, ...settings });
}

describe('LLMService agent model', () => {
  beforeEach(() => {
    mockAvailableProviders.splice(0, mockAvailableProviders.length, 'openai', 'anthropic', 'ollama');
  });

  it('uses a configured agentModel even when the chat model is a cloud model', () => {
    const llm = service({ agentModel: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
    expect(llm.getAgentModel()).toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5' });
  });

  it('keeps the cloud chat model when no agentModel is set', () => {
    expect(service({}).getAgentModel()).toEqual({ provider: 'openai', model: 'gpt-5.4' });
  });

  it('falls back to the first cloud provider when the chat model is local', () => {
    const llm = service({ defaultModel: { provider: 'ollama', model: 'llama3' } });
    expect(llm.getAgentModel()).toEqual({ provider: 'openai', model: '' });
  });

  it('exposes the agent defaults the subagent and prompt paths share', () => {
    const llm = service({
      agentModel: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      agentThinking: { enabled: true, effort: 'high' },
      agentTemperature: 0.3,
      defaultTemperature: 0.7,
      agentContextWindowOverrides: { k: 32_000 }
    });
    expect(llm.getAgentDefaults()).toEqual({
      model: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      thinking: { enabled: true, effort: 'high' },
      agentTemperature: 0.3,
      defaultTemperature: 0.7,
      contextWindowOverrides: { k: 32_000 }
    });
  });
});
