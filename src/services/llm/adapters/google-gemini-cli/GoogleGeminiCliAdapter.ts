/**
 * src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts
 *
 * LLM adapter for Google Gemini CLI. Runs the CLI as a child process in
 * non-streaming (JSON output) mode and parses the result.
 */
import { Vault } from 'obsidian';
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
import { CliProcessResult, runCliProcess } from '../../../../utils/cliProcessRunner';
import { GOOGLE_GEMINI_CLI_DEFAULT_MODEL } from './GoogleGeminiCliModels';
import {
  buildGeminiCliEnv,
  buildGeminiCliSystemSettings,
  resolveGeminiCliRuntime
} from '../../../../utils/geminiCli';

type ChildProcessHandle = {
  kill(): boolean;
};

type FsPromisesModule = typeof import('fs/promises');
type OsModule = typeof import('os');
type PathModule = typeof import('path');

type GeminiCliModuleMap = {
  'fs/promises': FsPromisesModule;
  os: OsModule;
  path: PathModule;
};

type RuntimeRequire = <K extends keyof GeminiCliModuleMap>(moduleName: K) => GeminiCliModuleMap[K];

type ModuleWithRequire = {
  require: RuntimeRequire;
};

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
  private activeProcess: ChildProcessHandle | null = null;

  constructor(private vault: Vault) {
    super('gemini-cli-local-auth', GOOGLE_GEMINI_CLI_DEFAULT_MODEL, 'gemini-cli://local', false);
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

    const { fsPromises, osModule, pathModule } = this.getNodeRuntime();

    const tempDir = await fsPromises.mkdtemp(pathModule.join(osModule.tmpdir(), 'nexus-gemini-cli-'));
    const settingsPath = pathModule.join(tempDir, 'system-settings.json');

    try {
      await fsPromises.writeFile(
        settingsPath,
        JSON.stringify(buildGeminiCliSystemSettings(runtime), null, 2),
        'utf8'
      );

      const combinedPrompt = this.buildPrompt(prompt, options?.systemPrompt);
      const args = [
        '--prompt',
        '',
        '--model',
        options?.model || this.currentModel,
        '--output-format',
        'json'
      ];

      const handle = runCliProcess(runtime.geminiPath, args, {
        cwd: runtime.vaultPath,
        env: buildGeminiCliEnv(settingsPath, runtime.nodePath),
        stdinText: combinedPrompt
      });
      this.activeProcess = handle.child;
      const result = await handle.result;
      this.activeProcess = null;

      if (result.exitCode !== 0) {
        throw this.mapCliProcessFailure(result);
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
    return ModelRegistry.getProviderModels('google-gemini-cli').map((model) => ModelRegistry.toModelInfo(model));
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
        return this.parseTrailingJsonBlock(trimmed);
      }

      try {
        return JSON.parse(lastJsonLine) as GeminiCliJsonResponse;
      } catch {
        return this.parseTrailingJsonBlock(trimmed);
      }
    }
  }

  private getNodeRuntime(): {
    fsPromises: FsPromisesModule;
    osModule: OsModule;
    pathModule: PathModule;
  } {
    const runtimeRequire = this.getRuntimeRequire();

    return {
      fsPromises: runtimeRequire('fs/promises'),
      osModule: runtimeRequire('os'),
      pathModule: runtimeRequire('path')
    };
  }

  private getRuntimeRequire(): RuntimeRequire {
    const globalRequire = this.getGlobalValue('require');
    if (typeof globalRequire === 'function') {
      return globalRequire as RuntimeRequire;
    }

    const runtimeModule = this.getGlobalValue('module');
    if (this.isModuleWithRequire(runtimeModule)) {
      return runtimeModule.require;
    }

    throw new LLMProviderError('Node runtime is unavailable for Gemini CLI execution.', this.name, 'CONFIGURATION_ERROR');
  }

  private getGlobalValue(propertyName: string): unknown {
    return Reflect.get(globalThis as object, propertyName);
  }

  private isModuleWithRequire(value: unknown): value is ModuleWithRequire {
    return typeof value === 'object'
      && value !== null
      && typeof Reflect.get(value, 'require') === 'function';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const modelStats = this.extractModelStats(parsed.stats?.models);
    if (!modelStats || typeof modelStats !== 'object') {
      return undefined;
    }

    const tokenStats = this.extractTokenStats(modelStats);
    const promptTokens = this.readNumber(tokenStats, ['prompt', 'promptTokens', 'inputTokens']);
    const completionTokens = this.readNumber(tokenStats, ['candidates', 'candidatesTokens', 'outputTokens', 'completionTokens']);
    const totalTokens = this.readNumber(tokenStats, ['total', 'totalTokens']);

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

  private parseTrailingJsonBlock(output: string): GeminiCliJsonResponse | null {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index].trim() !== '{') {
        continue;
      }

      try {
        return JSON.parse(lines.slice(index).join('\n')) as GeminiCliJsonResponse;
      } catch {
        continue;
      }
    }

    return null;
  }

  private extractModelStats(
    modelStats: Record<string, unknown>[] | Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (Array.isArray(modelStats)) {
      const firstEntry = modelStats[0];
      return this.isRecord(firstEntry) ? firstEntry : undefined;
    }

    if (!this.isRecord(modelStats)) {
      return undefined;
    }

    const firstEntry = Object.values(modelStats).find(
      (value) => this.isRecord(value)
    );

    return this.isRecord(firstEntry) ? firstEntry : undefined;
  }

  private extractTokenStats(modelStats: Record<string, unknown>): Record<string, unknown> {
    const tokens = modelStats.tokens;
    if (this.isRecord(tokens)) {
      return tokens;
    }

    return modelStats;
  }

  private mapCliProcessFailure(result: CliProcessResult): LLMProviderError {
    if (result.errorCode === 'ENAMETOOLONG' || result.errorCode === 'E2BIG') {
      return new LLMProviderError(
        'Gemini CLI could not start because the local CLI command was too long for this platform. Reduce attached context files or shorten the prompt and try again.',
        this.name,
        'REQUEST_TOO_LARGE'
      );
    }

    return new LLMProviderError(
      result.stderr.trim() || result.stdout.trim() || `Gemini CLI exited with status ${result.exitCode ?? 'unknown'}`,
      this.name,
      result.exitCode === null ? 'CONFIGURATION_ERROR' : 'PROVIDER_ERROR'
    );
  }
}
