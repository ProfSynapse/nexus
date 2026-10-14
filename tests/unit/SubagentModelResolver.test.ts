/**
 * Agent-run precedence (plan Decisions: "Subagent settings take effect").
 *
 * Defect this buys: the saved subagent model was ignored unless the chat model
 * was local, and the subagent tool always inherited the chat model. If the
 * precedence below regressed to "chat model first", the conversation and
 * default-agent cases go red. Sampling and thinking capabilities come from the
 * real registry (Claude Haiku 5.5 rejects temperature; Opus 4.6 accepts it;
 * Mistral Large cannot think).
 */
import {
  resolveAgentModel,
  resolveAgentRunSettings,
  resolveAgentTemperature
} from '../../src/services/llm/utils/SubagentModelResolver';
import { ModelRegistry } from '../../src/services/llm/adapters/ModelRegistry';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';

const chatCloud = { provider: 'openai', model: 'gpt-5.4' };
const chatLocal = { provider: 'ollama', model: 'llama3' };
const conversationAgent = { provider: 'anthropic', model: 'claude-haiku-5-5' };
const defaultAgent = { provider: 'google', model: 'gemini-3.5-flash' };
const available = ['ollama', 'openai', 'anthropic', 'google'];

describe('resolveAgentModel', () => {
  it.each([
    ['an explicit tool parameter wins', { explicit: { provider: 'google', model: 'gemini-3.8-flash' }, conversation: conversationAgent, defaultAgent, chat: chatCloud }, { provider: 'google', model: 'gemini-3.8-flash', source: 'explicit' }],
    ['the conversation subagent model beats the default and the chat', { conversation: conversationAgent, defaultAgent, chat: chatCloud }, { ...conversationAgent, source: 'conversation' }],
    ['the default subagent model beats a cloud chat model', { defaultAgent, chat: chatCloud }, { ...defaultAgent, source: 'default-agent' }],
    ['no subagent model and a cloud chat model: the chat model (today)', { chat: chatCloud }, { ...chatCloud, source: 'chat' }],
    ['no subagent model and a local chat model: the first cloud provider', { chat: chatLocal }, { provider: 'openai', model: '', source: 'cloud-fallback' }]
  ])('%s', (_label, input, expected) => {
    expect(resolveAgentModel({ ...input, availableProviders: available })).toEqual(expected);
  });

  it('borrows a lower layer model when the explicit parameter names only a provider', () => {
    expect(resolveAgentModel({ explicit: { provider: 'anthropic' }, defaultAgent: conversationAgent, chat: chatCloud, availableProviders: available }))
      .toEqual({ provider: 'anthropic', model: 'claude-haiku-5-5', source: 'explicit' });
  });

  it('skips a configured subagent model whose provider is no longer available', () => {
    expect(resolveAgentModel({ conversation: conversationAgent, defaultAgent, chat: chatCloud, availableProviders: ['openai', 'google'] }))
      .toEqual({ ...defaultAgent, source: 'default-agent' });
  });

  it('skips a cloud provider with no default model instead of pairing it with no model', () => {
    // An OpenAI-compatible instance has a custom id and no DEFAULT_MODELS entry.
    const providers = ['ollama', 'my-endpoint', 'anthropic'];
    expect(resolveAgentModel({ chat: chatLocal, availableProviders: providers, defaultModelFor: p => (p === 'anthropic' ? 'claude-sonnet-5' : undefined) }))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', source: 'cloud-fallback' });
  });

  it('stays on the chat model when no cloud provider has a default model', () => {
    expect(resolveAgentModel({ chat: chatLocal, availableProviders: ['ollama', 'my-endpoint'], defaultModelFor: () => undefined }))
      .toEqual({ ...chatLocal, source: 'unresolved' });
  });

  it('uses the supplied default model for a cloud fallback provider', () => {
    expect(resolveAgentModel({ chat: chatLocal, availableProviders: available, defaultModelFor: p => (p === 'openai' ? 'gpt-5.4' : undefined) }))
      .toEqual({ provider: 'openai', model: 'gpt-5.4', source: 'cloud-fallback' });
  });

  it('falls back to the chat model when nothing else can run', () => {
    expect(resolveAgentModel({ chat: chatLocal, availableProviders: ['ollama'] }))
      .toEqual({ ...chatLocal, source: 'unresolved' });
  });
});

describe('resolveAgentRunSettings', () => {
  it('drops temperature for a model that rejects sampling, and keeps thinking', () => {
    expect(ModelRegistry.findModel('anthropic', 'claude-haiku-5-5')?.supportsSamplingParams).toBe(false);

    const settings = resolveAgentRunSettings({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      conversation: { thinking: { enabled: true, effort: 'high' }, temperature: 0.3 }
    });

    expect(settings.temperature).toBeUndefined();
    expect(settings.thinking).toEqual({ enabled: true, effort: 'high' });
  });

  it('passes temperature for a model that accepts sampling', () => {
    expect(ModelRegistry.findModel('anthropic', 'claude-opus-4-6')?.supportsSamplingParams).not.toBe(false);
    expect(resolveAgentRunSettings({ provider: 'anthropic', model: 'claude-opus-4-6', conversation: { temperature: 0.3 } }).temperature).toBe(0.3);
  });

  it('gates thinking for a model that cannot think', () => {
    expect(resolveAgentRunSettings({
      provider: 'mistral',
      model: 'mistral-large-latest',
      defaults: { thinking: { enabled: true, effort: 'low' } }
    }).thinking).toEqual({ enabled: false, effort: 'low' });
  });

  it('prefers the conversation context window, then the subagent default, then the model window', () => {
    const key = getContextWindowOverrideKey('anthropic', 'claude-opus-4-6');
    const advertised = ModelRegistry.findModel('anthropic', 'claude-opus-4-6')?.contextWindow ?? 0;
    expect(advertised).toBeGreaterThan(64_000);

    expect(resolveAgentRunSettings({
      provider: 'anthropic', model: 'claude-opus-4-6',
      conversation: { contextWindow: 32_000 },
      defaults: { contextWindowOverrides: { [key]: 64_000 } }
    }).contextWindow).toBe(32_000);
    expect(resolveAgentRunSettings({
      provider: 'anthropic', model: 'claude-opus-4-6',
      defaults: { contextWindowOverrides: { [key]: 64_000 } }
    }).contextWindow).toBe(64_000);
    expect(resolveAgentRunSettings({ provider: 'anthropic', model: 'claude-opus-4-6' }).contextWindow).toBe(advertised);
  });

  it('clamps a stored budget to the model window and keeps a budget for unknown models', () => {
    expect(resolveAgentRunSettings({
      provider: 'mistral', model: 'magistral-medium-latest',
      conversation: { contextWindow: 5_000_000 }
    }).contextWindow).toBe(ModelRegistry.findModel('mistral', 'magistral-medium-latest')?.contextWindow);
    expect(resolveAgentRunSettings({ provider: 'ollama', model: 'llama3', conversation: { contextWindow: 16_000 } }).contextWindow).toBe(16_000);
    expect(resolveAgentRunSettings({ provider: 'ollama', model: 'llama3' }).contextWindow).toBeUndefined();
  });
});

describe('resolveAgentTemperature', () => {
  it('uses chat, then agent default, then default temperature, then 0.5', () => {
    expect(resolveAgentTemperature({ temperature: 0.1 }, { agentTemperature: 0.2, defaultTemperature: 0.3 })).toBe(0.1);
    expect(resolveAgentTemperature(null, { agentTemperature: 0.2, defaultTemperature: 0.3 })).toBe(0.2);
    expect(resolveAgentTemperature({ temperature: null }, { defaultTemperature: 0.3 })).toBe(0.3);
    expect(resolveAgentTemperature(null, null)).toBe(0.5);
    expect(resolveAgentTemperature({ temperature: 7 }, null)).toBe(1);
  });
});
