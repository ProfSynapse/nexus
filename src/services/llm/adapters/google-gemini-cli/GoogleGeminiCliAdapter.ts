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
import { composeAgyModelLabel } from './geminiCliModelNormalize';
import {
  buildGeminiCliEnv,
  resolveGeminiCliRuntime
} from '../../../../utils/geminiCli';

/**
 * agy `--print-timeout` accepts a Go-duration string (e.g. `60s`, `5m0s`), NOT
 * milliseconds — a raw integer is rejected ("missing unit in duration").
 *
 * SECURITY-LOAD-BEARING: this is the bounded kill-switch for a hung headless
 * tool-permission block. We never pass `--dangerously-skip-permissions`, so a
 * built-in-tool call would otherwise wait for an interactive approval that can
 * never arrive in print mode; this branch also has no inactivity watchdog, so
 * `--print-timeout` is the ONLY upper bound on a stuck process. Do NOT raise it
 * without restoring an idle/inactivity watchdog (e.g. after rebasing onto the
 * PR #276 watchdog). Trade-off: 60s may cut very-long thinking-model
 * completions on this interim branch — revisit the value once the watchdog lands.
 */
const AGY_PRINT_TIMEOUT = '60s';

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
      throw new LLMProviderError('Antigravity CLI (agy) was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.nodePath) {
      throw new LLMProviderError('Node.js was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.vaultPath) {
      throw new LLMProviderError('Vault filesystem path is unavailable.', this.name, 'CONFIGURATION_ERROR');
    }

    const combinedPrompt = this.buildPrompt(prompt, options?.systemPrompt);
    // Fail-closed model resolution: agy --model silently defaults on an unknown
    // value, so reject anything not in the allowlist before spawning. The agy
    // "Base (Effort)" label is composed here from the base model + the thinking/
    // effort slider value (options.thinkingEffort); legacy effort-variant slugs
    // carry their own explicit effort. See geminiCliModelNormalize.composeAgyModelLabel.
    const agyModel = composeAgyModelLabel(options?.model || this.currentModel, options?.thinkingEffort);

    // Scenario A invocation: no config write, no --dangerously-skip-permissions.
    // Print mode (--print) with the prompt delivered on stdin (stdinText below);
    // --print-timeout is the bounded security kill-switch; --sandbox is additive
    // defense-in-depth, added only where the sandbox backend is verified
    // (see shouldUseSandbox).
    const args = [
      '--print',
      '--model',
      agyModel,
      '--print-timeout',
      AGY_PRINT_TIMEOUT
    ];
    if (this.shouldUseSandbox()) {
      args.push('--sandbox');
    }

    const handle = runCliProcess(runtime.geminiPath, args, {
      cwd: runtime.vaultPath,
      env: buildGeminiCliEnv(runtime.nodePath),
      stdinText: combinedPrompt
    });
    this.activeProcess = handle.child;

    try {
      const result = await handle.result;

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
      // agy is text-completion only — no tool/function calling (investigation
      // #62/#64/#66). Matches the now-honest ModelSpecs; gating is via the
      // provider seam (isTextOnlyProvider), not this provider-level flag.
      supportsFunctions: false,
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

  /**
   * Effort now lives on the slider (options.thinkingEffort), not in the model
   * slug, so the base BaseAdapter cache key (which keys on model but not effort)
   * would collide two different efforts on the same base model + prompt. Fold the
   * composed agy "Base (Effort)" label into the key so each effort caches
   * distinctly. Falls back to the base key shape on any resolution error.
   */
  protected generateCacheKey(prompt: string, options?: GenerateOptions): string {
    let effortModel: string;
    try {
      effortModel = composeAgyModelLabel(options?.model || this.currentModel, options?.thinkingEffort);
    } catch {
      effortModel = `${options?.model || this.currentModel}::${options?.thinkingEffort ?? 'default'}`;
    }
    return super.generateCacheKey(prompt, { ...options, model: effortModel });
  }

  /**
   * Decide whether to pass agy's `--sandbox` flag.
   *
   * --sandbox is additive defense-in-depth (NOT the security foundation — that
   * is the no-MCP + no-skip-perms posture, which holds on every platform).
   *
   * On macOS it is verified to use the OS-native sandbox-exec/Seatbelt backend
   * (Docker-free, headless-safe). On other platforms the sandbox backend is
   * UNVERIFIED — upstream gemini-cli historically used gVisor/Docker on Linux,
   * which could fail (no daemon) and break an otherwise-valid completion. So we
   * pass --sandbox ONLY on darwin and fall back to the no-MCP + no-skip-perms
   * floor elsewhere. Revisit per-platform once non-darwin backends are verified.
   */
  private shouldUseSandbox(): boolean {
    return Platform.isMacOS === true;
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
        'Antigravity CLI (agy) could not start because the local CLI command was too long for this platform. Reduce attached context files or shorten the prompt and try again.',
        this.name,
        'REQUEST_TOO_LARGE'
      );
    }

    return new LLMProviderError(
      result.stderr.trim() || result.stdout.trim() || `Antigravity CLI (agy) exited with status ${result.exitCode ?? 'unknown'}`,
      this.name,
      result.exitCode === null ? 'CONFIGURATION_ERROR' : 'PROVIDER_ERROR'
    );
  }
}
