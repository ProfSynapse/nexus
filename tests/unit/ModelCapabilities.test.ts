/**
 * Capability answers for the settings rows. Failures this buys: a merged
 * sign-in provider (Claude Code, ChatGPT, Antigravity CLI) model looking
 * unknown and so losing its Thinking row and fixed temperature, a local
 * model's window never arriving (no Context window row), and the provider
 * being asked again on every redraw.
 */
import {
  getStaticModelCapabilities,
  ModelCapabilityResolver,
  type StaticModelLookup
} from '../../src/components/shared/chatSettings/modelCapabilities';
import type { ModelWithProvider } from '../../src/services/StaticModelsService';

function spec(provider: string, id: string, extra: Partial<ModelWithProvider> = {}): ModelWithProvider {
  return {
    provider,
    id,
    name: id.toUpperCase(),
    contextWindow: 200_000,
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    capabilities: { supportsJSON: true, supportsImages: false, supportsFunctions: true, supportsStreaming: true, supportsThinking: true },
    ...extra
  };
}

const registry: StaticModelLookup = {
  findModel: (provider, id) => [
    spec('anthropic', 'claude-opus-5-5', { supportsSamplingParams: false, contextWindow: 1_000_000 }),
    spec('mistral', 'mistral-large-latest', {
      capabilities: { supportsJSON: true, supportsImages: false, supportsFunctions: true, supportsStreaming: true, supportsThinking: false }
    })
  ].find(model => model.provider === provider && model.id === id)
};

it('reads thinking, sampling and window from the registry', () => {
  expect(getStaticModelCapabilities(registry, 'anthropic', 'claude-opus-5-5')).toEqual({
    supportsThinking: true, supportsSamplingParams: false, contextWindow: 1_000_000, name: 'CLAUDE-OPUS-5-5'
  });
  expect(getStaticModelCapabilities(registry, 'mistral', 'mistral-large-latest')).toMatchObject({
    supportsThinking: false, supportsSamplingParams: true
  });
  expect(getStaticModelCapabilities(registry, 'mistral', 'unknown')).toBeUndefined();
});

it('looks a merged sign-in provider up under its API provider', () => {
  expect(getStaticModelCapabilities(registry, 'anthropic-claude-code', 'claude-opus-5-5')?.supportsSamplingParams).toBe(false);
});

it('fetches an unknown model\'s window once and reports it when it arrives', async () => {
  const getModelsForProvider = jest.fn(async () => [{ id: 'qwen-local', contextWindow: 40_000 }]);
  const resolver = new ModelCapabilityResolver(registry, () => ({ getModelsForProvider }));
  const onDiscovered = jest.fn();

  expect(resolver.get('lmstudio', 'qwen-local', onDiscovered)).toEqual({ supportsThinking: false, supportsSamplingParams: true });
  resolver.get('lmstudio', 'qwen-local', onDiscovered);
  await new Promise(resolve => setImmediate(resolve));

  expect(getModelsForProvider).toHaveBeenCalledTimes(1);
  expect(onDiscovered).toHaveBeenCalledTimes(1);
  expect(resolver.get('lmstudio', 'qwen-local', onDiscovered).contextWindow).toBe(40_000);
  expect(getModelsForProvider).toHaveBeenCalledTimes(1);
});
