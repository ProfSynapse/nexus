/**
 * Shared model type definitions
 * Updated June 17, 2025
 */

export interface ModelSpec {
  /** Provider name (openai, google, anthropic, etc.) */
  provider: string;
  /** Human-readable model name */
  name: string;
  /** API identifier used in requests */
  apiName: string;
  /** Context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Input cost per million tokens in USD */
  inputCostPerMillion: number;
  /** Output cost per million tokens in USD */
  outputCostPerMillion: number;
  /** Cache-read (cache hit) input cost per million tokens in USD. Omit if the provider has no discount. */
  cacheReadCostPerMillion?: number;
  /** Cache-write (cache creation) input cost per million tokens in USD. Omit if the provider does not charge one. */
  cacheWriteCostPerMillion?: number;
  /** Model capabilities */
  capabilities: {
    supportsJSON: boolean;
    supportsImages: boolean;
    supportsFunctions: boolean;
    supportsStreaming: boolean;
    supportsThinking: boolean;
  };
  /** Optional beta headers required for this model (Anthropic only) */
  betaHeaders?: string[];
}