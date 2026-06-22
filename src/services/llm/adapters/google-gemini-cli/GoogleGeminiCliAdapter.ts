/**
 * src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter.ts
 *
 * LLM adapter for the Antigravity CLI (`agy`), wired into the legacy
 * `google-gemini-cli` provider slot. Runs the CLI as a child process in
 * non-streaming print mode. agy emits PLAIN TEXT (not JSON), so the response is
 * the trimmed stdout; no structured token usage is available from the CLI.
 */
import { Platform, Vault } from 'obsidian';
import type { DesktopChildProcess } from '../../../../utils/desktopProcess';
import { BaseAdapter } from '../BaseAdapter';
import {
  GenerateOptions,
  StreamChunk,
  LLMResponse,
  ModelInfo,
  ProviderCapabilities,
  ModelPricing,
  LLMProviderError
} from '../types';
import { ModelRegistry } from '../ModelRegistry';
import { CliProcessResult, runCliProcess } from '../../../../utils/cliProcessRunner';
import { GOOGLE_GEMINI_CLI_DEFAULT_MODEL } from './GoogleGeminiCliModels';
import { normalizeModelToAgyLabel } from './geminiCliModelNormalize';
import {
  buildGeminiCliEnv,
  buildGeminiCliSystemSettings,
  resolveGeminiCliRuntime
} from '../../../../utils/geminiCli';

type GeminiCliDesktopModuleMap = {
  'fs/promises': typeof import('fs/promises');
  os: typeof import('os');
  path: typeof import('path');
};

export class GoogleGeminiCliAdapter extends BaseAdapter {
  readonly name = 'google-gemini-cli';
  readonly baseUrl = 'gemini-cli://local';
  private activeProcess: DesktopChildProcess | null = null;

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

    const fsPromises = this.loadDesktopModule('fs/promises');
    const osMod = this.loadDesktopModule('os');
    const pathMod = this.loadDesktopModule('path');

    const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-gemini-cli-'));
    const settingsPath = pathMod.join(tempDir, 'system-settings.json');

    try {
      await fsPromises.writeFile(
        settingsPath,
        JSON.stringify(buildGeminiCliSystemSettings(runtime), null, 2),
        'utf8'
      );

      const combinedPrompt = this.buildPrompt(prompt, options?.systemPrompt);
      // Fail-closed model resolution: agy --model silently defaults on an unknown
      // value, so reject anything not in the allowlist before spawning.
      const agyModel = normalizeModelToAgyLabel(options?.model || this.currentModel);
      const args = [
        '--prompt',
        '',
        '--model',
        agyModel
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

      // agy print mode emits plain text — the response is the trimmed stdout.
      const text = this.parseAgyOutput(result.stdout);
      if (!text) {
        throw new LLMProviderError(
          'Antigravity CLI returned an empty response.',
          this.name,
          'PROVIDER_ERROR'
        );
      }

      // agy does not report token usage; omit it (buildLLMResponse defaults to zero).
      return this.buildLLMResponse(
        text,
        agyModel,
        undefined,
        {
          localCli: true,
          outputFormat: 'text'
        },
        'stop'
      );
    } finally {
      this.activeProcess = null;
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
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

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(ModelRegistry.getProviderModels('google-gemini-cli').map(model => ModelRegistry.toModelInfo(model)));
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: false,
      // agy print mode emits plain text only — there is no structured JSON output mode.
      supportsJSON: false,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 1048576,
      supportedFeatures: ['gemini-cli', 'mcp', 'google-login']
    };
  }

  getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const model = ModelRegistry.findModel('google-gemini-cli', modelId);
    if (!model) {
      return Promise.resolve(null);
    }

    return Promise.resolve({
      rateInputPerMillion: model.inputCostPerMillion,
      rateOutputPerMillion: model.outputCostPerMillion,
      currency: 'USD'
    });
  }

  abort(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  private loadDesktopModule<TModuleName extends keyof GeminiCliDesktopModuleMap>(
    moduleName: TModuleName
  ): GeminiCliDesktopModuleMap[TModuleName] {
    if (!Platform.isDesktop) {
      throw new Error(`${moduleName} is only available on desktop.`);
    }

    const maybeRequire = (window.activeWindow as Window & {
      require?: (moduleId: string) => unknown;
    }).require;

    if (typeof maybeRequire !== 'function') {
      throw new Error('Desktop module loader is unavailable.');
    }

    return maybeRequire(moduleName) as GeminiCliDesktopModuleMap[TModuleName];
  }

  private buildPrompt(prompt: string, systemPrompt?: string): string {
    if (!systemPrompt?.trim()) {
      return prompt;
    }

    return `System instructions:\n${systemPrompt.trim()}\n\nUser request:\n${prompt}`;
  }

  /**
   * Extract the assistant response from agy print-mode stdout.
   *
   * agy `--prompt` emits PLAIN TEXT (no JSON, no banner/footer noise), so the
   * response is simply the trimmed stdout. Returns an empty string for
   * empty/whitespace-only output; the caller treats that as a provider error.
   */
  private parseAgyOutput(stdout: string): string {
    return stdout.trim();
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
