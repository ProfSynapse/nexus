/* eslint-disable import/no-nodejs-modules -- desktop-only Claude Code adapter uses Node child_process in Electron */
import { Platform, Vault } from 'obsidian';
import type { ChildProcess } from 'child_process';
import { BaseAdapter } from '../BaseAdapter';
import { resolveDesktopBinaryPath } from '../../../../utils/binaryDiscovery';
import { getVaultBasePath, getConnectorPath } from '../../../../utils/cliPathUtils';
import { runCliProcess } from '../../../../utils/cliProcessRunner';
import { spawnDesktopProcess } from '../../../../utils/desktopProcess';
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
import { getPrimaryServerKey } from '../../../../constants/branding';

type ClaudeCodeToolCall = NonNullable<StreamChunk['toolCalls']>[number];
type ClaudeCodeDesktopModuleMap = {
  'fs/promises': typeof import('fs/promises');
  os: typeof import('os');
  path: typeof import('path');
  child_process: typeof import('child_process');
  readline: typeof import('readline');
};

const MAX_SAFE_WINDOWS_ARGV_CHARS = 24_000;

export class AnthropicClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'anthropic-claude-code';
  readonly baseUrl = 'claude-code://local';
  private activeProcess: ChildProcess | null = null;

  constructor(private vault: Vault) {
    super('claude-code-local-auth', 'claude-sonnet-4-6', 'claude-code://local', false);
    this.initializeCache();
  }

  async generateUncached(prompt: string, options?: GenerateOptions): Promise<LLMResponse> {
    const model = options?.model || this.currentModel;
    let fullText = '';
    let finalToolCalls: StreamChunk['toolCalls'];

    for await (const chunk of this.generateStreamAsync(prompt, options)) {
      if (chunk.content) {
        fullText += chunk.content;
      }

      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        finalToolCalls = chunk.toolCalls;
      }
    }

    return this.buildLLMResponse(
      fullText,
      model,
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      { localCli: true, providerExecutedTools: true },
      finalToolCalls && finalToolCalls.length > 0 ? 'tool_calls' : 'stop',
      finalToolCalls
    );
  }

  async* generateStreamAsync(prompt: string, options?: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const runtime = await this.getRuntime();
    if (!runtime.claudePath) {
      throw new LLMProviderError('Claude Code was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.connectorPath) {
      throw new LLMProviderError('Nexus connector.js was not found for this vault.', this.name, 'CONFIGURATION_ERROR');
    }
    if (!runtime.vaultPath) {
      throw new LLMProviderError('Vault filesystem path is unavailable.', this.name, 'CONFIGURATION_ERROR');
    }

    const authStatus = await this.readAuthStatus(runtime.claudePath, runtime.vaultPath);
    if (!authStatus.loggedIn) {
      throw new LLMProviderError(
        'Claude Code is not logged in. Connect it from the Anthropic provider card first.',
        this.name,
        'AUTHENTICATION_ERROR'
      );
    }

    const fsPromises = this.loadDesktopModule('fs/promises');
    const osMod = this.loadDesktopModule('os');
    const pathMod = this.loadDesktopModule('path');
    const childProcess = this.loadDesktopModule('child_process');
    const readline = this.loadDesktopModule('readline');

    const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-claude-code-adapter-'));
    const mcpConfigPath = pathMod.join(tempDir, 'mcp.json');
    const systemPromptPath = pathMod.join(tempDir, 'system-prompt.txt');
    const trimmedSystemPrompt = options?.systemPrompt?.trim();
    const toolCalls = new Map<string, ClaudeCodeToolCall>();
    let accumulatedText = '';
    let stderr = '';

    try {
      await fsPromises.writeFile(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [getPrimaryServerKey(this.vault.getName())]: {
              type: 'stdio',
              command: runtime.nodePath,
              args: [runtime.connectorPath]
            }
          }
        }, null, 2),
        'utf8'
      );

      const args = [
        '-p',
        '--verbose',
        '--strict-mcp-config',
        '--mcp-config',
        mcpConfigPath,
        '--tools',
        '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        '--output-format',
        'stream-json'
      ];

      if (trimmedSystemPrompt) {
        await fsPromises.writeFile(systemPromptPath, trimmedSystemPrompt, 'utf8');
        args.push('--append-system-prompt-file', systemPromptPath);
      }

      if (options?.enableThinking && options?.thinkingEffort) {
        args.push('--effort', options.thinkingEffort);
      }

      const model = options?.model || this.currentModel;
      if (model) {
        args.push('--model', model);
      }

      this.assertSafeWindowsArgv(runtime.claudePath, args);

      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = spawnDesktopProcess(childProcess, runtime.claudePath, args, {
        cwd: runtime.vaultPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.activeProcess = child;

      if (!child.stdin || !child.stdout || !child.stderr) {
        throw new LLMProviderError('Failed to capture Claude Code process output.', this.name, 'CONFIGURATION_ERROR');
      }

      const closePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(this.mapProcessError(error));
        });
        child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
          resolve({ exitCode, signal });
        });
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      await this.writePromptToStdin(child, prompt);

      const stdoutReader = readline.createInterface({ input: child.stdout });

      for await (const line of stdoutReader) {
        const parsed = this.parseStreamJsonLine(line);
        if (!parsed) {
          continue;
        }

        if (parsed.type === 'assistant') {
          const contentBlocks = this.extractContentBlocks(this.extractMessagePayload(parsed));
          const reasoningDelta = this.collectReasoningText(contentBlocks);
          if (reasoningDelta) {
            yield {
              content: '',
              complete: false,
              reasoning: reasoningDelta,
              reasoningComplete: true
            };
          }

          const toolUses = this.collectToolUses(contentBlocks);
          for (const toolUse of toolUses) {
            toolCalls.set(toolUse.id, toolUse);
          }

          const textDelta = this.collectAssistantText(contentBlocks);
          if (textDelta) {
            accumulatedText += textDelta;
            yield {
              content: textDelta,
              complete: false
            };
          }
        } else if (parsed.type === 'user') {
          const contentBlocks = this.extractContentBlocks(this.extractMessagePayload(parsed));
          this.applyToolResults(contentBlocks, toolCalls);
        } else if (parsed.type === 'result') {
          const resultText = typeof parsed.result === 'string' ? parsed.result : '';
          if (!accumulatedText && resultText) {
            accumulatedText = resultText;
            yield {
              content: resultText,
              complete: false
            };
          }
        }
      }

      const closeResult = await closePromise;

      if (closeResult.exitCode !== 0) {
        throw new LLMProviderError(
          stderr.trim() || `Claude Code exited with status ${closeResult.exitCode ?? 'unknown'}`,
          this.name,
          'PROVIDER_ERROR'
        );
      }

      const finalizedToolCalls = Array.from(toolCalls.values()).map((toolCall) => ({
        ...toolCall,
        providerExecuted: true,
        success: toolCall.success !== false
      }));

      yield {
        content: '',
        complete: true,
        toolCalls: finalizedToolCalls.length > 0 ? finalizedToolCalls : undefined,
        metadata: {
          authMethod: authStatus.authMethod,
          localCli: true,
          providerExecutedTools: true
        }
      };
    } finally {
      this.activeProcess = null;
      try {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = ModelRegistry.getProviderModels('anthropic-claude-code');
    return models.map(model => ModelRegistry.toModelInfo(model));
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStreaming: true,
      streamingMode: 'buffered',
      supportsJSON: true,
      supportsImages: true,
      supportsFunctions: true,
      supportsThinking: true,
      maxContextWindow: 200000,
      supportedFeatures: ['claude-code', 'mcp', 'subscription-auth']
    };
  }

  async getModelPricing(modelId: string): Promise<ModelPricing | null> {
    const model = ModelRegistry.findModel('anthropic-claude-code', modelId);
    if (!model) {
      return null;
    }

    return {
      rateInputPerMillion: model.inputCostPerMillion,
      rateOutputPerMillion: model.outputCostPerMillion,
      currency: 'USD'
    };
  }

  private async getRuntime(): Promise<{
    claudePath: string | null;
    nodePath: string | null;
    connectorPath: string | null;
    vaultPath: string | null;
  }> {
    const claudePath = resolveDesktopBinaryPath('claude');
    const nodePath = resolveDesktopBinaryPath('node');
    const vaultPath = getVaultBasePath(this.vault);

    if (!nodePath) {
      throw new LLMProviderError('Node.js was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }

    return {
      claudePath,
      nodePath,
      connectorPath: getConnectorPath(vaultPath, this.vault.configDir),
      vaultPath
    };
  }

  private loadDesktopModule<TModuleName extends keyof ClaudeCodeDesktopModuleMap>(
    moduleName: TModuleName
  ): ClaudeCodeDesktopModuleMap[TModuleName] {
    if (!Platform.isDesktop) {
      throw new Error(`${moduleName} is only available on desktop.`);
    }

    const maybeRequire = (globalThis as typeof globalThis & {
      require?: (moduleId: string) => unknown;
    }).require;

    if (typeof maybeRequire !== 'function') {
      throw new Error('Desktop module loader is unavailable.');
    }

    return maybeRequire(moduleName) as ClaudeCodeDesktopModuleMap[TModuleName];
  }

  private parseStreamJsonLine(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private extractMessagePayload(parsed: Record<string, unknown>): Record<string, unknown> | null {
    const message = parsed.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      return message as Record<string, unknown>;
    }

    return parsed;
  }

  private extractContentBlocks(messagePayload: Record<string, unknown> | null): Record<string, unknown>[] {
    if (!messagePayload) {
      return [];
    }

    const content = messagePayload.content;
    if (!Array.isArray(content)) {
      return [];
    }

    return content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && !Array.isArray(block));
  }

  private collectAssistantText(contentBlocks: Record<string, unknown>[]): string {
    return contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .join('');
  }

  private collectReasoningText(contentBlocks: Record<string, unknown>[]): string {
    return contentBlocks
      .filter((block) => block.type === 'thinking' || block.type === 'reasoning')
      .map((block) => {
        if (typeof block.thinking === 'string') {
          return block.thinking;
        }
        if (typeof block.text === 'string') {
          return block.text;
        }
        if (typeof block.summary === 'string') {
          return block.summary;
        }
        return '';
      })
      .join('');
  }

  private collectToolUses(contentBlocks: Record<string, unknown>[]): ClaudeCodeToolCall[] {
    return contentBlocks
      .filter((block) => block.type === 'tool_use')
      .map((block, index) => {
        const toolName = typeof block.name === 'string' ? block.name : 'unknown_tool';
        const toolInput = this.normalizeToolInput(block.input);
        const toolId = typeof block.id === 'string'
          ? block.id
          : `claude_tool_${index}_${Date.now()}`;

        return {
          id: toolId,
          type: 'function',
          name: toolName,
          function: {
            name: toolName,
            arguments: JSON.stringify(toolInput)
          },
          parameters: toolInput,
          providerExecuted: true
        };
      });
  }

  private applyToolResults(
    contentBlocks: Record<string, unknown>[],
    toolCalls: Map<string, ClaudeCodeToolCall>
  ): void {
    for (const block of contentBlocks) {
      if (block.type !== 'tool_result') {
        continue;
      }

      const toolUseId = typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : typeof block.toolUseId === 'string'
          ? block.toolUseId
          : typeof block.id === 'string'
            ? block.id
            : null;

      if (!toolUseId) {
        continue;
      }

      const existing = toolCalls.get(toolUseId);
      if (!existing) {
        continue;
      }

      const normalizedResult = this.normalizeToolResultContent(block.content);
      const isError = block.is_error === true || block.isError === true;

      existing.result = normalizedResult;
      existing.success = !isError;
      existing.error = isError
        ? typeof normalizedResult === 'string'
          ? normalizedResult
          : JSON.stringify(normalizedResult, null, 2)
        : undefined;
    }
  }

  private normalizeToolInput(input: unknown): Record<string, unknown> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return input as Record<string, unknown>;
    }

    return {};
  }

  private normalizeToolResultContent(content: unknown): unknown {
    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return content;
    }

    const blocks = content as unknown[];
    const normalized = blocks.map((block: unknown) => {
      if (!block || typeof block !== 'object') {
        return block;
      }

      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
        return typedBlock.text;
      }

      return typedBlock;
    });

    if (normalized.every((item) => typeof item === 'string')) {
      return normalized.join('\n');
    }

    return normalized;
  }


  abort(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = null;
    }
  }

  private async readAuthStatus(claudePath: string, cwd: string): Promise<{ loggedIn: boolean; authMethod: string }> {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    const handle = runCliProcess(claudePath, ['auth', 'status'], { cwd, env });
    const result = await handle.result;
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string };
      return {
        loggedIn: !!parsed.loggedIn,
        authMethod: parsed.authMethod || 'unknown'
      };
    } catch {
      return {
        loggedIn: false,
        authMethod: 'unknown'
      };
    }
  }

  private estimateArgvChars(command: string, args: string[]): number {
    return [command, ...args].reduce((total, value) => total + value.length + 1, 0);
  }

  private assertSafeWindowsArgv(command: string, args: string[]): void {
    if (!Platform.isWin) {
      return;
    }

    const estimatedArgvChars = this.estimateArgvChars(command, args);
    if (estimatedArgvChars > MAX_SAFE_WINDOWS_ARGV_CHARS) {
      throw new LLMProviderError(
        'Claude Code could not start because the local CLI command was too long for Windows command-line limits. Reduce attached context files and try again.',
        this.name,
        'REQUEST_TOO_LARGE'
      );
    }
  }

  private async writePromptToStdin(child: ChildProcess, prompt: string): Promise<void> {
    const stdin = child.stdin;
    if (!stdin) {
      throw new LLMProviderError('Failed to open Claude Code stdin for prompt input.', this.name, 'CONFIGURATION_ERROR');
    }

    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        stdin.off('error', handleError);
        reject(this.mapProcessError(error));
      };

      stdin.once('error', handleError);
      stdin.end(prompt, 'utf8', () => {
        stdin.off('error', handleError);
        resolve();
      });
    });
  }

  private mapProcessError(error: Error): LLMProviderError {
    const errnoError = error as NodeJS.ErrnoException;
    if (errnoError.code === 'ENAMETOOLONG' || errnoError.code === 'E2BIG') {
      return new LLMProviderError(
        'Claude Code could not start because the local CLI command was too long for this platform. Reduce attached context files or shorten the prompt and try again.',
        this.name,
        'REQUEST_TOO_LARGE',
        error
      );
    }

    return new LLMProviderError(
      error.message || 'Claude Code failed to start.',
      this.name,
      'PROVIDER_ERROR',
      error
    );
  }
}
