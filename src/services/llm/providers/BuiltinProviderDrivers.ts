import type { Vault } from 'obsidian';
import type { LLMProviderConfig } from '../../../types';
import type { BaseAdapter } from '../adapters/BaseAdapter';
import type { CodexOAuthTokens } from '../adapters/openai-codex/OpenAICodexAdapter';
import {
  providerDriverKind,
  type ProviderCompatibility,
  type ProviderDriver,
  type ProviderInstance,
} from './ProviderDriver';

export interface BuiltinProviderDriverRegistration {
  driver: ProviderDriver<LLMProviderConfig>;
  shouldInitialize(config: LLMProviderConfig | undefined, vault?: Vault): boolean;
}

interface DriverDefinition<TAdapter extends BaseAdapter> {
  kind: string;
  displayName: string;
  compatibility: ProviderCompatibility;
  shouldInitialize(config: LLMProviderConfig | undefined, vault?: Vault): boolean;
  createAdapter(input: {
    config: LLMProviderConfig;
    vault?: Vault;
    onSettingsDirty?: () => void;
  }): Promise<TAdapter>;
  onCreated?(adapter: TAdapter): Promise<void> | void;
  beforeDispose?(adapter: TAdapter): Promise<void> | void;
}

function isProviderConfig(value: unknown): value is LLMProviderConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { apiKey?: unknown; enabled?: unknown };
  return typeof candidate.apiKey === 'string' && typeof candidate.enabled === 'boolean';
}

function validateProviderConfig(value: unknown): LLMProviderConfig {
  if (!isProviderConfig(value)) {
    throw new Error('Provider config must contain a string apiKey and boolean enabled flag');
  }
  return value;
}

function hasDispose(adapter: BaseAdapter): adapter is BaseAdapter & {
  dispose(): Promise<void> | void;
} {
  return typeof (adapter as { dispose?: unknown }).dispose === 'function';
}

async function disposeAdapter(
  adapter: BaseAdapter,
  beforeDispose?: () => Promise<void> | void
): Promise<void> {
  try {
    await beforeDispose?.();
  } finally {
    if (hasDispose(adapter)) {
      await adapter.dispose();
    }
  }
}

function defineDriver<TAdapter extends BaseAdapter>(
  definition: DriverDefinition<TAdapter>
): BuiltinProviderDriverRegistration {
  const kind = providerDriverKind(definition.kind);

  return {
    shouldInitialize: (config, vault) => definition.shouldInitialize(config, vault),
    driver: {
      kind,
      displayName: definition.displayName,
      compatibility: definition.compatibility,
      validateConfig: validateProviderConfig,
      async createInstance(input): Promise<ProviderInstance> {
        const adapter = await definition.createAdapter(input);
        try {
          await definition.onCreated?.(adapter);
        } catch (error) {
          await disposeAdapter(adapter);
          throw error;
        }

        let disposed = false;
        return {
          id: input.instanceId,
          driverKind: kind,
          displayName: input.displayName,
          adapter,
          async dispose(): Promise<void> {
            if (disposed) return;
            disposed = true;
            await disposeAdapter(
              adapter,
              definition.beforeDispose
                ? () => definition.beforeDispose?.(adapter)
                : undefined
            );
          },
        };
      },
    },
  };
}

function enabledWithApiKey(config: LLMProviderConfig | undefined): boolean {
  return config?.enabled === true && typeof config.apiKey === 'string' && config.apiKey.length > 0;
}

function enabledWithVault(config: LLMProviderConfig | undefined, vault?: Vault): boolean {
  return config?.enabled === true && Boolean(vault);
}

export function createBuiltinProviderDrivers(): BuiltinProviderDriverRegistration[] {
  return [
    defineDriver({
      kind: 'openrouter',
      displayName: 'OpenRouter',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { OpenRouterAdapter } = await import('../adapters/openrouter/OpenRouterAdapter');
        return new OpenRouterAdapter(config.apiKey, {
          httpReferer: config.httpReferer,
          xTitle: config.xTitle,
        });
      },
    }),
    defineDriver({
      kind: 'requesty',
      displayName: 'Requesty',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { RequestyAdapter } = await import('../adapters/requesty/RequestyAdapter');
        return new RequestyAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'perplexity',
      displayName: 'Perplexity',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { PerplexityAdapter } = await import('../adapters/perplexity/PerplexityAdapter');
        return new PerplexityAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'openai',
      displayName: 'OpenAI',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { OpenAIAdapter } = await import('../adapters/openai/OpenAIAdapter');
        return new OpenAIAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'anthropic',
      displayName: 'Anthropic',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { AnthropicAdapter } = await import('../adapters/anthropic/AnthropicAdapter');
        return new AnthropicAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'google',
      displayName: 'Google',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { GoogleAdapter } = await import('../adapters/google/GoogleAdapter');
        return new GoogleAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'mistral',
      displayName: 'Mistral',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { MistralAdapter } = await import('../adapters/mistral/MistralAdapter');
        return new MistralAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'groq',
      displayName: 'Groq',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { GroqAdapter } = await import('../adapters/groq/GroqAdapter');
        return new GroqAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'deepseek',
      displayName: 'DeepSeek',
      compatibility: 'all',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { DeepSeekAdapter } = await import('../adapters/deepseek/DeepSeekAdapter');
        return new DeepSeekAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'openai-codex',
      displayName: 'OpenAI Codex',
      compatibility: 'desktop-only',
      shouldInitialize: (config) => Boolean(
        config?.enabled
        && config.oauth?.connected
        && config.apiKey
        && config.oauth.refreshToken
        && config.oauth.metadata?.accountId
      ),
      createAdapter: async ({ config, onSettingsDirty }) => {
        const oauth = config.oauth;
        if (!oauth?.refreshToken || !oauth.metadata?.accountId) {
          throw new Error('OpenAI Codex OAuth configuration is incomplete');
        }

        const { OpenAICodexAdapter } = await import('../adapters/openai-codex/OpenAICodexAdapter');
        const tokens: CodexOAuthTokens = {
          accessToken: config.apiKey,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt || 0,
          accountId: oauth.metadata.accountId,
        };
        return new OpenAICodexAdapter(tokens, (newTokens) => {
          config.apiKey = newTokens.accessToken;
          const oauthState = config.oauth;
          if (oauthState) {
            oauthState.refreshToken = newTokens.refreshToken;
            oauthState.expiresAt = newTokens.expiresAt;
          }
          onSettingsDirty?.();
        });
      },
    }),
    defineDriver({
      kind: 'anthropic-claude-code',
      displayName: 'Claude Code',
      compatibility: 'desktop-only',
      shouldInitialize: (config, vault) => Boolean(config?.enabled && config.oauth?.connected && vault),
      createAdapter: async ({ vault }) => {
        if (!vault) throw new Error('Claude Code requires a vault');
        const { AnthropicClaudeCodeAdapter } = await import('../adapters/anthropic-claude-code/AnthropicClaudeCodeAdapter');
        return new AnthropicClaudeCodeAdapter(vault);
      },
    }),
    defineDriver({
      kind: 'google-gemini-cli',
      displayName: 'Gemini CLI',
      compatibility: 'desktop-only',
      shouldInitialize: (config, vault) => Boolean(config?.enabled && config.oauth?.connected && vault),
      createAdapter: async ({ vault }) => {
        if (!vault) throw new Error('Gemini CLI requires a vault');
        const { GoogleGeminiCliAdapter } = await import('../adapters/google-gemini-cli/GoogleGeminiCliAdapter');
        return new GoogleGeminiCliAdapter(vault);
      },
    }),
    defineDriver({
      kind: 'github-copilot',
      displayName: 'GitHub Copilot',
      compatibility: 'desktop-only',
      shouldInitialize: (config) => Boolean(config?.enabled && config.oauth?.connected && config.apiKey),
      createAdapter: async ({ config }) => {
        const { GithubCopilotAdapter } = await import('../adapters/github-copilot/GithubCopilotAdapter');
        return new GithubCopilotAdapter(config.apiKey);
      },
    }),
    defineDriver({
      kind: 'ollama',
      displayName: 'Ollama',
      compatibility: 'desktop-only',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { OllamaAdapter } = await import('../adapters/ollama/OllamaAdapter');
        return new OllamaAdapter(
          config.apiKey,
          config.ollamaModel || '',
          config.ollamaContextLength,
          config.ollamaSpeculativeDecoding,
          config.ollamaDraftNumPredict
        );
      },
    }),
    defineDriver({
      kind: 'lmstudio',
      displayName: 'LM Studio',
      compatibility: 'desktop-only',
      shouldInitialize: enabledWithApiKey,
      createAdapter: async ({ config }) => {
        const { LMStudioAdapter } = await import('../adapters/lmstudio/LMStudioAdapter');
        return new LMStudioAdapter(config.apiKey, {
          contextLength: config.lmstudioContextLength,
          flashAttention: config.lmstudioFlashAttention,
          draftModel: config.lmstudioDraftModel,
        });
      },
    }),
    defineDriver({
      kind: 'webllm',
      displayName: 'Nexus local',
      compatibility: 'desktop-only',
      shouldInitialize: enabledWithVault,
      createAdapter: async ({ vault }) => {
        if (!vault) throw new Error('Nexus local requires a vault');
        const { WebLLMAdapter } = await import('../adapters/webllm/WebLLMAdapter');
        return new WebLLMAdapter(vault);
      },
      onCreated: async (adapter) => {
        const { getWebLLMLifecycleManager } = await import('../adapters/webllm/WebLLMLifecycleManager');
        getWebLLMLifecycleManager().setAdapter(adapter);
      },
      beforeDispose: async (adapter) => {
        const { getWebLLMLifecycleManager } = await import('../adapters/webllm/WebLLMLifecycleManager');
        getWebLLMLifecycleManager().clearAdapter(adapter);
      },
    }),
  ];
}
