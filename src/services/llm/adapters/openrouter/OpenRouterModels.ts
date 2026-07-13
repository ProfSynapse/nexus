/**
 * OpenRouter Model Specifications
 * OpenRouter provides access to multiple providers through a unified API
 * Updated July 2026 — added the GPT-5.6 family; pruned superseded
 * Claude 4.5 Opus/Sonnet, Gemini 2.5 / 3.0 Preview, and GPT-5 / GPT-5.1 entries
 */

import { ModelSpec } from '../modelTypes';

// OpenRouter provides access to models from other providers.
// Keep this list alphabetized by display name for consistent dropdown ordering.
export const OPENROUTER_MODELS: ModelSpec[] = [
  {
    provider: 'openrouter',
    name: 'Claude 4.5 Haiku',
    apiName: 'anthropic/claude-haiku-4-5',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 5.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.6',
    apiName: 'anthropic/claude-opus-4.6',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.6 (1M)',
    apiName: 'anthropic/claude-opus-4.6',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.7',
    apiName: 'anthropic/claude-opus-4.7',
    contextWindow: 200000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.7 (1M)',
    apiName: 'anthropic/claude-opus-4.7',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Opus 4.8',
    apiName: 'anthropic/claude-opus-4.8',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 25.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Fable 5',
    apiName: 'anthropic/claude-fable-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 10.00,
    outputCostPerMillion: 50.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6',
    apiName: 'anthropic/claude-sonnet-4.6',
    contextWindow: 200000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6 (1M)',
    apiName: 'anthropic/claude-sonnet-4.6',
    contextWindow: 1000000,
    maxTokens: 64000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Claude Sonnet 5',
    apiName: 'anthropic/claude-sonnet-5',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 3.00,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GLM 5.1',
    apiName: 'z-ai/glm-5.1',
    contextWindow: 202752,
    maxTokens: 65536,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 3.20,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GLM 5.2',
    apiName: 'z-ai/glm-5.2',
    contextWindow: 1000000,
    maxTokens: 128000,
    inputCostPerMillion: 1.40,
    outputCostPerMillion: 4.40,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GLM 5V Turbo',
    apiName: 'z-ai/glm-5v-turbo',
    contextWindow: 202752,
    maxTokens: 65536,
    inputCostPerMillion: 1.20,
    outputCostPerMillion: 4.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Gemini 3.1 Flash Lite Preview',
    apiName: 'google/gemini-3.1-flash-lite-preview',
    contextWindow: 1048576,
    maxTokens: 64000,
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Gemini 3.1 Pro Preview',
    apiName: 'google/gemini-3.1-pro-preview',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 2.00,
    outputCostPerMillion: 12.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Gemini 3.5 Flash',
    apiName: 'google/gemini-3.5-flash',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.50,
    outputCostPerMillion: 9.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.2',
    apiName: 'openai/gpt-5.2',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.2 Pro',
    apiName: 'openai/gpt-5.2-pro',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 21.00,
    outputCostPerMillion: 168.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.3 Chat',
    apiName: 'openai/gpt-5.3-chat-latest',
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.3 Codex',
    apiName: 'openai/gpt-5.3-codex',
    contextWindow: 128000,
    maxTokens: 16384,
    inputCostPerMillion: 1.75,
    outputCostPerMillion: 14.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.4',
    apiName: 'openai/gpt-5.4',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 2.50,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.4 Mini',
    apiName: 'openai/gpt-5.4-mini',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 4.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.4 Nano',
    apiName: 'openai/gpt-5.4-nano',
    contextWindow: 400000,
    maxTokens: 128000,
    inputCostPerMillion: 0.20,
    outputCostPerMillion: 1.25,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.4 Pro',
    apiName: 'openai/gpt-5.4-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 30.00,
    outputCostPerMillion: 180.00,
    capabilities: {
      supportsJSON: false,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.5',
    apiName: 'openai/gpt-5.5',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 30.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.5 Pro',
    apiName: 'openai/gpt-5.5-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 30.00,
    outputCostPerMillion: 180.00,
    capabilities: {
      supportsJSON: false,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Luna',
    apiName: 'openai/gpt-5.6-luna',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 6.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Luna Pro',
    apiName: 'openai/gpt-5.6-luna-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 6.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Sol',
    apiName: 'openai/gpt-5.6-sol',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 30.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Sol Pro',
    apiName: 'openai/gpt-5.6-sol-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 5.00,
    outputCostPerMillion: 30.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Terra',
    apiName: 'openai/gpt-5.6-terra',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 2.50,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'GPT-5.6 Terra Pro',
    apiName: 'openai/gpt-5.6-terra-pro',
    contextWindow: 1050000,
    maxTokens: 128000,
    inputCostPerMillion: 2.50,
    outputCostPerMillion: 15.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Kimi K2.7 Code',
    apiName: 'moonshotai/kimi-k2.7-code',
    contextWindow: 262144,
    maxTokens: 16384,
    inputCostPerMillion: 0.74,
    outputCostPerMillion: 3.50,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'MiMo-V2-Omni',
    apiName: 'xiaomi/mimo-v2-omni',
    contextWindow: 262144,
    maxTokens: 65536,
    inputCostPerMillion: 0.40,
    outputCostPerMillion: 2.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'MiMo-V2-Pro',
    apiName: 'xiaomi/mimo-v2-pro',
    contextWindow: 1048576,
    maxTokens: 65536,
    inputCostPerMillion: 1.00,
    outputCostPerMillion: 3.00,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'MiniMax M2.7',
    apiName: 'minimax/minimax-m2.7',
    contextWindow: 204800,
    maxTokens: 65536,
    inputCostPerMillion: 0.30,
    outputCostPerMillion: 1.20,
    capabilities: {
      supportsJSON: true,
      supportsImages: false,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
  {
    provider: 'openrouter',
    name: 'Qwen3.5-27B',
    apiName: 'qwen/qwen3.5-27b',
    contextWindow: 262144,
    maxTokens: 65536,
    inputCostPerMillion: 0.195,
    outputCostPerMillion: 1.56,
    capabilities: {
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsStreaming: true,
      supportsThinking: true
    }
  },
];

export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-5.6-sol';
