/**
 * OpenAI Deep Research Handler
 * Handles deep research models that use the Responses API
 * Separate from streaming chat functionality
 */

import OpenAI from 'openai';
import { GenerateOptions, LLMResponse, TokenUsage } from '../types';
import { LLMProviderError } from '../types';
import type {
  Response,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText
} from 'openai/resources/responses/responses';

/**
 * Type guard to check if an output item is a message
 */
function isResponseOutputMessage(item: ResponseOutputItem): item is ResponseOutputMessage {
  return item.type === 'message';
}

/**
 * Type guard to check if content is output text
 */
function isResponseOutputText(content: ResponseOutputMessage['content'][number]): content is ResponseOutputText {
  return content.type === 'output_text';
}

/**
 * Usage information structure
 */
interface UsageInfo {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/**
 * Type guard to check if an item has usage information
 */
function hasUsage(item: unknown): item is { usage: UsageInfo } {
  return typeof item === 'object' && item !== null && 'usage' in item && item.usage !== undefined;
}

export class DeepResearchHandler {
  constructor(private client: OpenAI) {}

  /**
   * Check if a model is a deep research model
   */
  isDeepResearchModel(model: string): boolean {
    return model.includes('deep-research') || model.includes('gpt-5.2-pro');
  }

  /**
   * Generate response using deep research model
   */
  async generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || 'sonar-deep-research';

    // Build input format for Deep Research API
    const input: any[] = [];

    // Add system message if provided
    if (options?.systemPrompt) {
      input.push({
        role: 'developer',
        content: [{ type: 'input_text', text: options.systemPrompt }]
      });
    }

    // Add user message
    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: prompt }]
    });

    const requestParams: any = {
      model,
      input,
      reasoning: { summary: 'auto' },
      background: true // Enable async processing
    };

    // Add tools if specified, default to web_search_preview for deep research models
    if (model.includes('deep-research')) {
        requestParams.tools = [{ type: 'web_search_preview' }];
    }

    // Add optional tools if specified
    if (options?.tools && options.tools.length > 0) {
      // Convert tools to Deep Research API format
      const drTools = options.tools.map(tool => {
        if (tool.type === 'function') {
          return { type: 'code_interpreter', container: { type: 'auto', file_ids: [] } };
        }
        return { type: tool.type };
      });
      requestParams.tools = [...(requestParams.tools || []), ...drTools];
    }

    try {
      // Submit the deep research request
      const response = await this.client.responses.create(requestParams);

      // Poll for completion if response is not immediately ready
      let finalResponse = response;
      if (response.status === 'in_progress' || !this.isComplete(response)) {
        finalResponse = await this.pollForCompletion(response.id, model);
      }

      // Extract the final report from the output array
      return this.parseResponse(finalResponse, model);
    } catch (error) {
      console.error(`[DeepResearchHandler] Deep research failed for ${model}:`, error);
      throw new LLMProviderError(
        `Deep research generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'openai',
        'DEEP_RESEARCH_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if deep research response is complete
   */
  private isComplete(response: Response): boolean {
    return response.output &&
           response.output.length > 0 &&
           response.output.some((item) => {
             if (!isResponseOutputMessage(item)) return false;
             if (!item.content || item.content.length === 0) return false;
             const firstContent = item.content[0];
             return isResponseOutputText(firstContent) && Boolean(firstContent.text);
           });
  }

  /**
   * Poll for deep research completion
   */
  private async pollForCompletion(responseId: string, model: string, maxWaitTime = 300000): Promise<Response> {
    const startTime = Date.now();
    const pollInterval = (model.includes('o4-mini') || model.includes('gpt-5.2-pro')) ? 2000 : 5000; // Faster polling for mini model and pro model

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await this.client.responses.retrieve(responseId);

        if (response.status === 'completed' || this.isComplete(response)) {
          return response;
        }

        if (response.status === 'failed' || response.status === 'cancelled') {
          throw new Error(`Deep research ${response.status}: ${response.error || 'Unknown error'}`);
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));

      } catch (error) {
        if (error instanceof Error && error.message.includes('Deep research')) {
          throw error; // Re-throw deep research specific errors
        }
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`Deep research timed out after ${maxWaitTime}ms`);
  }

  /**
   * Parse deep research response structure
   */
  private parseResponse(response: Response, model: string): LLMResponse {
    if (!response.output || response.output.length === 0) {
      throw new Error('No output received from deep research');
    }

    // Find the final message in the output array
    const finalOutput = response.output[response.output.length - 1];

    if (!isResponseOutputMessage(finalOutput) || !finalOutput.content || finalOutput.content.length === 0) {
      throw new Error('Invalid deep research response structure');
    }

    const content = finalOutput.content[0];
    if (!isResponseOutputText(content)) {
      throw new Error('Expected text output from deep research');
    }

    const text = content.text || '';
    const annotations = content.annotations || [];

    // Extract usage information if available
    let usage: TokenUsage | undefined;
    const usageOutput = response.output.find((item): item is ResponseOutputItem & { usage: UsageInfo } => hasUsage(item));
    if (usageOutput?.usage) {
      usage = {
        promptTokens: usageOutput.usage.prompt_tokens || usageOutput.usage.input_tokens || 0,
        completionTokens: usageOutput.usage.completion_tokens || usageOutput.usage.output_tokens || 0,
        totalTokens: usageOutput.usage.total_tokens || 0
      };
    }

    // Build metadata with citations
    const metadata: Record<string, unknown> = {
      deepResearch: true,
      citations: annotations.map((annotation) => {
        // Only process URL citations
        if ('url' in annotation && annotation.type === 'url_citation') {
          return {
            title: annotation.title,
            url: annotation.url,
            startIndex: annotation.start_index,
            endIndex: annotation.end_index
          };
        }
        return null;
      }).filter((citation): citation is NonNullable<typeof citation> => citation !== null),
      intermediateSteps: response.output.length - 1, // Number of intermediate processing steps
      processingTime: response.metadata?.processing_time_ms
    };

    return {
      text,
      model,
      provider: 'openai',
      usage,
      metadata,
      finishReason: 'stop' // Deep research always completes normally
    };
  }
}
