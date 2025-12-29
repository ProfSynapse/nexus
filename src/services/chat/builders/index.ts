/**
 * Context Builders - Provider-specific conversation context formatting
 *
 * This module exports all context builder related types and utilities.
 */

// Interface and types
export type {
  IContextBuilder,
  MessageValidationContext,
  LLMMessage,
  LLMToolCall,
  ToolExecutionResult,
  LLMContentBlock,
  OpenAIMessage,
  AnthropicMessage,
  GoogleMessage
} from './IContextBuilder';

// Concrete builders
export { OpenAIContextBuilder } from './OpenAIContextBuilder';
export { AnthropicContextBuilder } from './AnthropicContextBuilder';
export { GoogleContextBuilder } from './GoogleContextBuilder';
export { CustomFormatContextBuilder } from './CustomFormatContextBuilder';

// Factory
export {
  getContextBuilder,
  getProviderCategory,
  isOpenAICompatible,
  isCustomFormat,
  usesCustomToolFormat
} from './ContextBuilderFactory';

export type { ProviderCategory } from './ContextBuilderFactory';
