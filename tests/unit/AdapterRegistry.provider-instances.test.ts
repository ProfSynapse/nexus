/**
 * Failure bought: the driver refactor cannot rename legacy provider IDs, load a
 * desktop-only adapter on mobile, or leave WebLLM cleanup in the generic facade.
 * Adapter constructors are mocked; this lane proves registry wiring, not HTTP.
 */
import type { Vault } from 'obsidian';
import type { LLMProviderSettings } from '../../src/types';
import { AdapterRegistry } from '../../src/services/llm/core/AdapterRegistry';
import { createBuiltinProviderDrivers } from '../../src/services/llm/providers/BuiltinProviderDrivers';
import { defaultProviderInstanceId } from '../../src/services/llm/providers/ProviderDriver';

const mockIsMobile = jest.fn(() => false);
const mockOpenAIDispose = jest.fn(async () => undefined);
const mockOpenAIAdapter = jest.fn().mockImplementation(() => ({
  name: 'openai',
  dispose: mockOpenAIDispose,
}));
const mockOllamaAdapter = jest.fn().mockImplementation(() => ({ name: 'ollama' }));
const mockWebLLMDispose = jest.fn(async () => undefined);
const mockWebLLMAdapter = jest.fn().mockImplementation(() => ({
  name: 'webllm',
  dispose: mockWebLLMDispose,
}));
const mockSetWebLLMAdapter = jest.fn();
const mockClearWebLLMAdapter = jest.fn();

jest.mock('../../src/utils/platform', () => ({
  isMobile: () => mockIsMobile(),
}));
jest.mock('../../src/services/llm/adapters/openai/OpenAIAdapter', () => ({
  OpenAIAdapter: mockOpenAIAdapter,
}));
jest.mock('../../src/services/llm/adapters/ollama/OllamaAdapter', () => ({
  OllamaAdapter: mockOllamaAdapter,
}));
jest.mock('../../src/services/llm/adapters/webllm/WebLLMAdapter', () => ({
  WebLLMAdapter: mockWebLLMAdapter,
}));
jest.mock('../../src/services/llm/adapters/webllm/WebLLMLifecycleManager', () => ({
  getWebLLMLifecycleManager: () => ({
    setAdapter: mockSetWebLLMAdapter,
    clearAdapter: mockClearWebLLMAdapter,
  }),
}));

function settings(
  providers: LLMProviderSettings['providers']
): LLMProviderSettings {
  return {
    providers,
    defaultModel: { provider: 'openai', model: 'test-model' },
  };
}

describe('AdapterRegistry provider instances', () => {
  beforeEach(() => {
    mockIsMobile.mockReturnValue(false);
    jest.clearAllMocks();
  });

  it('uses the legacy provider ID as the implicit default instance ID', async () => {
    const registry = new AdapterRegistry(settings({}));
    registry.initialize(settings({
      openai: { enabled: true, apiKey: 'test-key' },
    }));
    await registry.waitForInit();

    const instance = registry.getProviderInstance('openai');
    const driver = registry.getProviderDriver('openai');
    expect(instance?.id).toBe(defaultProviderInstanceId(driver!.kind));
    expect(instance?.driverKind).toBe(driver?.kind);
    expect(registry.getAdapter('openai')).toBe(instance?.adapter);
    expect(registry.getAvailableProviders()).toEqual(['openai']);

    await registry.dispose();
  });

  it('keeps aliases as a compatibility resolver instead of instance identity', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new AdapterRegistry(settings({}));
    registry.initialize(settings({
      openai: { enabled: true, apiKey: 'test-key' },
    }));
    await registry.waitForInit();

    expect(registry.getProviderInstance('openai-codex')).toBeUndefined();
    expect(registry.getAdapter('openai-codex')).toBe(registry.getAdapter('openai'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("falling back to 'openai'"));

    warn.mockRestore();
    await registry.dispose();
  });

  it('serializes settings refresh and disposes the superseded instance', async () => {
    const registry = new AdapterRegistry(settings({}));
    registry.initialize(settings({
      openai: { enabled: true, apiKey: 'test-key' },
    }));
    registry.initialize(settings({
      openai: { enabled: false, apiKey: 'test-key' },
    }));

    await registry.waitForInit();

    expect(mockOpenAIAdapter).toHaveBeenCalledTimes(1);
    expect(mockOpenAIDispose).toHaveBeenCalledTimes(1);
    expect(registry.getAvailableProviders()).toEqual([]);

    await registry.dispose();
  });

  it('checks driver compatibility before importing a desktop-only adapter', async () => {
    mockIsMobile.mockReturnValue(true);
    const registry = new AdapterRegistry(settings({}));
    registry.initialize(settings({
      openai: { enabled: true, apiKey: 'test-key' },
      ollama: { enabled: true, apiKey: 'http://127.0.0.1:11434' },
    }));
    await registry.waitForInit();

    expect(registry.getAvailableProviders()).toEqual(['openai']);
    expect(mockOpenAIAdapter).toHaveBeenCalledTimes(1);
    expect(mockOllamaAdapter).not.toHaveBeenCalled();

    await registry.dispose();
  });

  it('gives WebLLM lifecycle ownership to its provider instance', async () => {
    const registration = createBuiltinProviderDrivers().find(({ driver }) => driver.kind === 'webllm');
    expect(registration).toBeDefined();
    const driver = registration!.driver;
    const instance = await driver.createInstance({
      instanceId: defaultProviderInstanceId(driver.kind),
      displayName: driver.displayName,
      config: { enabled: true, apiKey: '' },
      vault: {} as Vault,
    });

    expect(mockSetWebLLMAdapter).toHaveBeenNthCalledWith(1, instance.adapter);
    await instance.dispose();
    await instance.dispose();
    expect(mockClearWebLLMAdapter).toHaveBeenCalledWith(instance.adapter);
    expect(mockClearWebLLMAdapter).toHaveBeenCalledTimes(1);
    expect(mockSetWebLLMAdapter).toHaveBeenCalledTimes(1);
    expect(mockWebLLMDispose).toHaveBeenCalledTimes(1);
  });

  it('registers every current provider without importing adapter modules eagerly', () => {
    const drivers = createBuiltinProviderDrivers().map(({ driver }) => ({
      kind: driver.kind,
      compatibility: driver.compatibility,
    }));

    expect(drivers).toEqual([
      { kind: 'openrouter', compatibility: 'all' },
      { kind: 'requesty', compatibility: 'all' },
      { kind: 'perplexity', compatibility: 'all' },
      { kind: 'openai', compatibility: 'all' },
      { kind: 'anthropic', compatibility: 'all' },
      { kind: 'google', compatibility: 'all' },
      { kind: 'mistral', compatibility: 'all' },
      { kind: 'groq', compatibility: 'all' },
      { kind: 'deepseek', compatibility: 'all' },
      { kind: 'openai-codex', compatibility: 'desktop-only' },
      { kind: 'anthropic-claude-code', compatibility: 'desktop-only' },
      { kind: 'google-gemini-cli', compatibility: 'desktop-only' },
      { kind: 'github-copilot', compatibility: 'desktop-only' },
      { kind: 'ollama', compatibility: 'desktop-only' },
      { kind: 'lmstudio', compatibility: 'desktop-only' },
      { kind: 'webllm', compatibility: 'desktop-only' },
    ]);
  });
});
