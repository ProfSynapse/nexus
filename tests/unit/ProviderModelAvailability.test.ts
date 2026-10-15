/**
 * A retired model must never stop a provider from being set up; it should only
 * be impossible to turn on. These tests cover the provider model list lookup
 * and the provider settings that lock off unlisted models.
 */

import { App, __setRequestUrlMock, createFakeRoot, type FakeElement } from 'obsidian';
import {
  fetchListedModelIds,
  isModelListed
} from '../../src/services/llm/validation/ProviderModelAvailability';
import { GenericProviderModal } from '../../src/components/llm-provider/providers/GenericProviderModal';
import type { ProviderModalConfig, ProviderModalDependencies } from '../../src/components/llm-provider/types';

const mockRequestUrl = jest.fn();
const ok = (json: unknown) => ({ status: 200, json, text: JSON.stringify(json), headers: {} });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  mockRequestUrl.mockReset();
  __setRequestUrlMock(mockRequestUrl);
});

describe('fetchListedModelIds', () => {
  it('reads OpenAI-style lists from data[].id', async () => {
    mockRequestUrl.mockResolvedValue(ok({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }));

    await expect(fetchListedModelIds('openai', 'key')).resolves.toEqual(new Set(['gpt-a', 'gpt-b']));
    expect(mockRequestUrl.mock.calls[0][0]).toMatchObject({
      url: 'https://api.openai.com/v1/models',
      method: 'GET',
      headers: { Authorization: 'Bearer key' }
    });
  });

  it('reads Google lists from models[].name without the models/ prefix, past the first page', async () => {
    mockRequestUrl.mockResolvedValue(ok({ models: [{ name: 'models/gemini-x' }] }));

    await expect(fetchListedModelIds('google', 'key')).resolves.toEqual(new Set(['gemini-x']));
    expect(mockRequestUrl.mock.calls[0][0].url).toContain('pageSize=1000');
  });

  it('asks Anthropic for more than its default page of models', async () => {
    mockRequestUrl.mockResolvedValue(ok({ data: [{ id: 'claude-x' }] }));

    await fetchListedModelIds('anthropic', 'key');
    expect(mockRequestUrl.mock.calls[0][0].url).toContain('limit=1000');
  });

  it('lists OpenRouter models without a key, because that list is public', async () => {
    mockRequestUrl.mockResolvedValue(ok({ data: [{ id: 'vendor/model' }] }));

    await expect(fetchListedModelIds('openrouter', '')).resolves.toEqual(new Set(['vendor/model']));
    expect(mockRequestUrl.mock.calls[0][0].headers).toEqual({});
  });

  it.each([
    ['a failed request', () => mockRequestUrl.mockResolvedValue({ status: 500, json: {}, text: '', headers: {} })],
    ['a thrown error', () => mockRequestUrl.mockRejectedValue(new Error('offline'))],
    ['an empty list', () => mockRequestUrl.mockResolvedValue(ok({ data: [] }))]
  ])('returns null, not an empty list, after %s', async (_label, arrange) => {
    arrange();
    await expect(fetchListedModelIds('openai', 'key')).resolves.toBeNull();
  });

  it('returns null for providers without a usable list, and for a missing key', async () => {
    await expect(fetchListedModelIds('perplexity', 'key')).resolves.toBeNull();
    await expect(fetchListedModelIds('openai', '')).resolves.toBeNull();
    expect(mockRequestUrl).not.toHaveBeenCalled();
  });
});

describe('isModelListed', () => {
  const listed = new Set(['anthropic/claude-haiku-4.5', 'xiaomi/mimo-v2.6-pro']);

  it('accepts an alias that differs only in dots and hyphens', () => {
    // OpenRouter serves anthropic/claude-haiku-4-5 but lists anthropic/claude-haiku-4.5.
    expect(isModelListed('anthropic/claude-haiku-4-5', listed)).toBe(true);
  });

  it('rejects a model the provider no longer lists', () => {
    expect(isModelListed('xiaomi/mimo-v2-pro', listed)).toBe(false);
  });
});

describe('GenericProviderModal model availability', () => {
  const models = [
    { provider: 'openrouter', id: 'vendor/current', name: 'Current model' },
    { provider: 'openrouter', id: 'vendor/retired', name: 'Retired model' }
  ];

  function renderModal() {
    const onConfigChange = jest.fn();
    const config = {
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      keyFormat: 'sk-or-...',
      signupUrl: 'https://openrouter.ai/keys',
      config: { enabled: true, apiKey: 'sk-or-key', models: { 'vendor/retired': { enabled: true } } },
      onConfigChange
    } as unknown as ProviderModalConfig;
    const deps = {
      app: new App(),
      staticModelsService: {
        getConfigurableModelsForProvider: () => models,
        getModelsForProvider: () => models
      }
    } as unknown as ProviderModalDependencies;
    const root = createFakeRoot();
    new GenericProviderModal(config, deps).render(root as unknown as HTMLElement);
    return { root, config, onConfigChange };
  }

  const item = (root: FakeElement, name: string) =>
    root.querySelectorAll('.model-item').find(el => el.textContent?.includes(name))!;

  it('locks off a model the provider no longer lists and leaves the saved setting alone', async () => {
    mockRequestUrl.mockResolvedValue(ok({ data: [{ id: 'vendor/current' }] }));
    const { root, config, onConfigChange } = renderModal();
    await flush();

    const retired = item(root, 'Retired model');
    expect(retired.hasClass('is-unavailable')).toBe(true);
    expect(retired.textContent).toContain('No longer available from OpenRouter');
    const retiredToggle = retired.querySelector('.checkbox-container')!;
    expect(retiredToggle.disabled).toBe(true);
    expect(retiredToggle.hasClass('is-enabled')).toBe(false);

    retiredToggle.click();
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(config.config.models?.['vendor/retired']).toEqual({ enabled: true });

    const current = item(root, 'Current model');
    expect(current.hasClass('is-unavailable')).toBe(false);
    expect(current.querySelector('.checkbox-container')!.disabled).toBeFalsy();
  });

  it('keeps every model available when the list cannot be fetched', async () => {
    mockRequestUrl.mockRejectedValue(new Error('offline'));
    const { root } = renderModal();
    await flush();

    expect(root.querySelectorAll('.model-item.is-unavailable')).toHaveLength(0);
    expect(item(root, 'Retired model').querySelector('.checkbox-container')!.disabled).toBeFalsy();
  });
});
