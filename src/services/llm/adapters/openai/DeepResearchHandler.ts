/**
 * OpenAI Deep Research Handler
 * Handles deep research models via the Responses API without the SDK.
 */

import { GenerateOptions, LLMResponse, TokenUsage, LLMProviderError } from '../types';
import { ProviderHttpClient } from '../shared/ProviderHttpClient';

interface UsageInfo {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface DeepResearchInputContentPart {
  type: 'input_text';
  text: string;
}

interface DeepResearchInputItem {
  role: 'developer' | 'user';
  content: DeepResearchInputContentPart[];
}

interface DeepResearchTool {
  type: string;
  container?: {
    type: string;
    file_ids: string[];
  };
}

interface DeepResearchRequestParams {
  model: string;
  input: DeepResearchInputItem[];
  reasoning: {
    summary: 'auto';
  };
  background: true;
  tools?: DeepResearchTool[];
}

interface DeepResearchAnnotation {
  type?: string;
  title?: string;
  url?: string;
  start_index?: number;
  end_index?: number;
}

interface DeepResearchOutputTextContent {
  type?: string;
  text?: string;
  annotations?: DeepResearchAnnotation[];
}

interface DeepResearchOutputItem {
  type?: string;
  id?: string;
  content?: DeepResearchOutputTextContent[];
  usage?: UsageInfo;
  encrypted_content?: string | null;
}

interface DeepResearchResponse {
  id?: string;
  status?: string;
  output?: DeepResearchOutputItem[];
  error?: string;
  metadata?: {
    processing_time_ms?: number;
  };
}

export class DeepResearchHandler {
  constructor(
    private apiKey: string,
    private baseUrl: string = 'https://api.openai.com/v1'
  ) {}

  isDeepResearchModel(model: string): boolean {
    return model.includes('deep-research')
      || model.includes('gpt-5.2-pro')
      || model.includes('gpt-5.4-pro');
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || 'sonar-deep-research';

    const input: DeepResearchInputItem[] = [];
    if (options?.systemPrompt) {
      input.push({
        role: 'developer',
        content: [{ type: 'input_text', text: options.systemPrompt }]
      });
    }

    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: prompt }]
    });

    const requestParams: DeepResearchRequestParams = {
      model,
      input,
      reasoning: { summary: 'auto' },
      background: true
    };

    if (model.includes('deep-research')) {
      requestParams.tools = [{ type: 'web_search_preview' }];
    }

    if (options?.tools && options.tools.length > 0) {
      const drTools = options.tools.map((tool) => {
        if (tool.type === 'function') {
          return { type: 'code_interpreter', container: { type: 'auto', file_ids: [] } };
        }
        return { type: tool.type };
      });
      requestParams.tools = [...(requestParams.tools || []), ...drTools];
    }

    try {
      const response = await ProviderHttpClient.request<DeepResearchResponse>({
        url: `${this.baseUrl}/responses`,
        provider: 'openai',
        operation: 'deep research generation',
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(requestParams),
        timeoutMs: 120_000,
        retries: 2
      });

      if (!response.ok || !response.json) {
        throw new Error(response.text || `HTTP ${response.status}`);
      }

      let finalResponse: DeepResearchResponse = response.json;
      if (finalResponse.status === 'in_progress' || !this.isComplete(finalResponse)) {
        if (!finalResponse.id) {
          throw new Error('Deep research response missing response id');
        }
        finalResponse = await this.pollForCompletion(finalResponse.id, model);
      }

      return this.parseResponse(finalResponse, model);
    } catch (error) {
      throw new LLMProviderError(
        `Deep research generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'openai',
        'DEEP_RESEARCH_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  private async pollForCompletion(
    responseId: string,
    model: string,
    maxWaitTime = 300000
  ): Promise<DeepResearchResponse> {
    const startTime = Date.now();
    const pollInterval = (
      model.includes('o4-mini')
      || model.includes('gpt-5.2-pro')
      || model.includes('gpt-5.4-pro')
    ) ? 2000 : 5000;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        const response = await ProviderHttpClient.request<DeepResearchResponse>({
          url: `${this.baseUrl}/responses/${responseId}`,
          provider: 'openai',
          operation: 'deep research poll',
          method: 'GET',
          headers: this.buildHeaders(),
          timeoutMs: 30_000
        });

        if (!response.ok || !response.json) {
          throw new Error(response.text || `HTTP ${response.status}`);
        }

        if (response.json.status === 'completed' || this.isComplete(response.json)) {
          return response.json;
        }

        if (response.json.status === 'failed' || response.json.status === 'cancelled') {
          throw new Error(`Deep research ${response.json.status}: ${response.json.error || 'Unknown error'}`);
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        if (error instanceof Error && error.message.includes('Deep research')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`Deep research timed out after ${maxWaitTime}ms`);
  }

  private isComplete(response: DeepResearchResponse): boolean {
    return !!(response.output &&
      response.output.length > 0 &&
      response.output.some((item) => {
        if (item.type !== 'message') return false;
        if (!item.content || item.content.length === 0) return false;
        const firstContent = item.content[0];
        return firstContent?.type === 'output_text' && Boolean(firstContent.text);
      }));
  }

  private parseResponse(response: DeepResearchResponse, model: string): LLMResponse {
    if (!response.output || response.output.length === 0) {
      throw new Error('No output received from deep research');
    }

    const finalOutput = response.output[response.output.length - 1];
    if (finalOutput.type !== 'message' || !finalOutput.content || finalOutput.content.length === 0) {
      throw new Error('Invalid deep research response structure');
    }

    const content = finalOutput.content[0];
    if (content.type !== 'output_text') {
      throw new Error('Expected text output from deep research');
    }

    const text = content.text || '';
    const annotations = content.annotations || [];

    let usage: TokenUsage | undefined;
    const usageOutput = response.output.find(item => item?.usage);
    const rawUsage: UsageInfo | undefined = usageOutput?.usage;
    if (rawUsage) {
      usage = {
        promptTokens: rawUsage.prompt_tokens || rawUsage.input_tokens || 0,
        completionTokens: rawUsage.completion_tokens || rawUsage.output_tokens || 0,
        totalTokens: rawUsage.total_tokens || 0
      };
    }

    const metadata: Record<string, unknown> = {
      deepResearch: true,
      citations: annotations
        .map((annotation) => {
          if (annotation.type !== 'url_citation' || !annotation.url) {
            return null;
          }

          return {
            title: annotation.title,
            url: annotation.url,
            startIndex: annotation.start_index,
            endIndex: annotation.end_index
          };
        })
        .filter((citation: unknown) => citation !== null),
      intermediateSteps: response.output.length - 1,
      processingTime: response.metadata?.processing_time_ms
    };

    return {
      text,
      model,
      provider: 'openai',
      usage,
      metadata,
      finishReason: 'stop'
    };
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }
}
