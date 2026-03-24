/**
 * src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts
 *
 * LLM adapter for Google Gemini CLI. Runs the CLI as a child process in
 * non-streaming (JSON output) mode and parses the result.
 */
import { Vault } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  LLMProviderError,
  TokenUsage
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { runCliProcess } from '../../../../utils/cliProcessRunner';
import {
  buildGeminiCliEnv,
  buildGeminiCliSystemSettings,
  resolveGeminiCliRuntime
} from '../../../../utils/geminiCli';

interface GeminiCliJsonResponse {
  response?: string;
  text?: string;
  content?: string;
  output?: string;
  result?: {
    text?: string;
  };
  stats?: {
    models?: Array<Record<string, unknown>>;
    tools?: unknown;
  };
  error?: string | { message?: string };
}

export class GoogleGeminiCliAdapter extends BaseAdapter {
  readonly name = 'google-gemini-cli';
  readonly baseUrl = 'gemini-cli://local';
  private activeProcess: ChildProcess | null = null;

  constructor(private vault: Vault) {
    super('gemini-cli-local-auth', 'gemini-2.5-pro', 'gemini-cli://local', false);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const runtime = resolveGeminiCliRuntime(this.vault);
    if (!runtime.geminiPath) {
      throw new LLMProviderError('Gemini CLI was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.nodePath) {
      throw new LLMProviderError('Node.js was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.connectorPath) {
      throw new LLMProviderError('Nexus connector.js was not found for this vault.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.vaultPath) {
      throw new LLMProviderError('Vault filesystem path is unavailable.', this.name, 'CONFIGURATION_ERROR');
    }

    const fsPromises = require('fs/promises') as typeof import('fs/promises');
    const osMod = require('os') as typeof import('os');
    const pathMod = require('path') as typeof import('path');

    const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-gemini-cli-'));
    const settingsPath = pathMod.join(tempDir, 'system-settings.json');

    try {
      await fsPromises.writeFile(
        settingsPath,
        JSON.stringify(buildGeminiCliSystemSettings(runtime), null, 2),
        'utf8'
      );

      const combinedPrompt = this.buildPrompt(prompt, options?.systemPrompt);
      const args = [
        '--prompt',
        combinedPrompt,
        '--model',
        options?.model || this.currentModel,
        '--output-format',
        'json'
      ];

      const handle = runCliProcess(runtime.geminiPath, args, {
        cwd: runtime.vaultPath,
        env: buildGeminiCliEnv(settingsPath, runtime.nodePath)
      });
      this.activeProcess = handle.child;
      const result = await handle.result;
      this.activeProcess = null;

      if (result.exitCode !== 0) {
        throw new LLMProviderError(
          result.stderr.trim() || result.stdout.trim() || `Gemini CLI exited with status ${result.exitCode ?? 'unknown'}`,
          this.name,
          result.exitCode === null ? 'CONFIGURATION_ERROR' : 'PROVIDER_ERROR'
        );
      }

      const parsed = this.parseOutput(result.stdout);
      if (!parsed) {
        throw new LLMProviderError(
          'Gemini CLI returned an unreadable JSON response.',
          this.name,
          'PROVIDER_ERROR'
        );
      }

      const errorMessage = typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message;
      if (errorMessage) {
        throw new LLMProviderError(errorMessage, this.name, 'PROVIDER_ERROR');
      }

      const text = this.extractText(parsed);
      const usage = this.extractUsageFromStats(parsed);

      return this.buildLLMResponse(
        text,
        options?.model || this.currentModel,
        usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        {
          localCli: true,
          outputFormat: 'json',
          toolSummary: parsed.stats?.tools
        },
        'stop'
      );
    } finally {
      this.activeProcess = null;
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await this.generateUncached(prompt, options);
    yield {
      content: response.text,
      complete: true,
      usage: response.usage
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return ModelRegistry.getProviderModels('google-gemini-cli').map(model => ModelRegistry.toModelInfo(model));
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 1048576,
      supportedFeatures: ['gemini-cli', 'mcp', 'google-login']
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const model = ModelRegistry.findModel('google-gemini-cli', modelId);
    if (!model) {
      return null;
    }

    return {
      rateInputPerMillion: model.inputCostPerMillion,
      rateOutputPerMillion: model.outputCostPerMillion,
      currency: 'USD'
    };
  }

  abort(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  private buildPrompt(prompt: string, systemPrompt?: string): string {
    if (!systemPrompt?.trim()) {
      return prompt;
    }

    return `System instructions:\n${systemPrompt.trim()}\n\nUser request:\n${prompt}`;
  }

  private parseOutput(stdout: string): GeminiCliJsonResponse | null {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as GeminiCliJsonResponse;
    } catch {
      const lastJsonLine = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => line.startsWith('{') && line.endsWith('}'));

      if (!lastJsonLine) {
        return null;
      }

      try {
        return JSON.parse(lastJsonLine) as GeminiCliJsonResponse;
      } catch {
        return null;
      }
    }
  }

  private extractText(parsed: GeminiCliJsonResponse): string {
    if (typeof parsed.response === 'string') return parsed.response;
    if (typeof parsed.text === 'string') return parsed.text;
    if (typeof parsed.content === 'string') return parsed.content;
    if (typeof parsed.output === 'string') return parsed.output;
    if (typeof parsed.result?.text === 'string') return parsed.result.text;
    return '';
  }

  private extractUsageFromStats(parsed: GeminiCliJsonResponse): TokenUsage | undefined {
    const modelStats = Array.isArray(parsed.stats?.models) ? parsed.stats?.models[0] : undefined;
    if (!modelStats || typeof modelStats !== 'object') {
      return undefined;
    }

    const promptTokens = this.readNumber(modelStats, ['promptTokens', 'inputTokens']);
    const completionTokens = this.readNumber(modelStats, ['candidatesTokens', 'outputTokens', 'completionTokens']);
    const totalTokens = this.readNumber(modelStats, ['totalTokens']);

    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return undefined;
    }

    return {
      promptTokens: promptTokens || 0,
      completionTokens: completionTokens || 0,
      totalTokens: totalTokens || ((promptTokens || 0) + (completionTokens || 0))
    };
  }

  private readNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }
}
