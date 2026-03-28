import { Platform, Vault } from 'obsidian';
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
import type { ModelSpec } from '../ModelRegistry';
import { getPrimaryServerKey } from '../../../../constants/branding';

type JsonRecord = Record<string, unknown>;
type ClaudeCodeToolCall = NonNullable<StreamChunk['toolCalls']>[number];
type DesktopChildProcess = ReturnType<typeof spawnDesktopProcess>;
type DesktopChildProcessModule = Parameters<typeof spawnDesktopProcess>[0];
type DesktopSpawnOptions = Parameters<typeof spawnDesktopProcess>[3];
type ProcessStdout = NonNullable<DesktopChildProcess['stdout']>;

interface FsPromisesModule {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: string, encoding: string): Promise<void>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

interface OsModule {
  tmpdir(): string;
}

interface PathModule {
  join(...paths: string[]): string;
}

interface ReadlineInterfaceLike extends AsyncIterable<string> {
  close(): void;
}

interface ReadlineModule {
  createInterface(options: { input: ProcessStdout }): ReadlineInterfaceLike;
}

interface ProcessError extends Error {
  code?: string;
}

type BuiltinModuleMap = {
  'fs/promises': FsPromisesModule;
  os: OsModule;
  path: PathModule;
  child_process: DesktopChildProcessModule;
  readline: ReadlineModule;
};

const MAX_SAFE_WINDOWS_ARGV_CHARS = 24_000;

export class AnthropicClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'anthropic-claude-code';
  readonly baseUrl = 'claude-code://local';
  private activeProcess: DesktopChildProcess | null = null;

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

    const fsPromises = this.loadNodeBuiltin('fs/promises');
    const osMod = this.loadNodeBuiltin('os');
    const pathMod = this.loadNodeBuiltin('path');
    const childProcess = this.loadNodeBuiltin('child_process');
    const readline = this.loadNodeBuiltin('readline');

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

      const spawnOptions: DesktopSpawnOptions = {
        cwd: runtime.vaultPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      };
      const child = spawnDesktopProcess(childProcess, runtime.claudePath, args, spawnOptions);
      this.activeProcess = child;

      if (!child.stdin || !child.stdout || !child.stderr) {
        throw new LLMProviderError('Failed to capture Claude Code process output.', this.name, 'CONFIGURATION_ERROR');
      }

      const closePromise = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', (error: ProcessError) => {
          reject(this.mapProcessError(error));
        });
        child.once('close', (exitCode: number | null, signal: string | null) => {
          resolve({ exitCode, signal });
        });
      });

      child.stderr.on('data', (chunk: unknown) => {
        stderr += this.coerceChunkToString(chunk);
      });

      await this.writePromptToStdin(child, prompt);

      const stdoutReader = readline.createInterface({ input: child.stdout });

      try {
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
      } finally {
        stdoutReader.close();
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
    const models: ModelSpec[] = ModelRegistry.getProviderModels('anthropic-claude-code');
    return models.map((model) => this.toModelInfo(model));
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
      connectorPath: getConnectorPath(vaultPath),
      vaultPath
    };
  }

  private loadNodeBuiltin<K extends keyof BuiltinModuleMap>(moduleName: K): BuiltinModuleMap[K] {
    const processWithBuiltinLoader = process as typeof process & {
      getBuiltinModule?: (id: string) => unknown;
    };
    const builtinLoader = processWithBuiltinLoader.getBuiltinModule;
    if (typeof builtinLoader === 'function') {
      const loadedModule = builtinLoader(moduleName) as BuiltinModuleMap[K] | undefined;
      if (loadedModule) {
        return loadedModule;
      }
    }

    const globalScope = globalThis as typeof globalThis & {
      require?: (id: string) => unknown;
    };
    const globalRequire = globalScope.require;
    if (typeof globalRequire === 'function') {
      const loadedModule = globalRequire(moduleName) as BuiltinModuleMap[K];
      return loadedModule;
    }

    throw new LLMProviderError(
      `Node builtin module "${moduleName}" is unavailable in this runtime.`,
      this.name,
      'CONFIGURATION_ERROR'
    );
  }

  private isJsonRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  private coerceChunkToString(chunk: unknown): string {
    if (typeof chunk === 'string') {
      return chunk;
    }

    if (chunk instanceof Uint8Array) {
      return new TextDecoder().decode(chunk);
    }

    return String(chunk);
  }

  private parseJsonRecord(value: string): JsonRecord | null {
    try {
      const parsed: unknown = JSON.parse(value);
      return this.isJsonRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private parseStreamJsonLine(line: string): JsonRecord | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    return this.parseJsonRecord(trimmed);
  }

  private extractMessagePayload(parsed: JsonRecord): JsonRecord | null {
    const message = parsed.message;
    if (this.isJsonRecord(message)) {
      return message;
    }

    return parsed;
  }

  private extractContentBlocks(messagePayload: JsonRecord | null): JsonRecord[] {
    if (!messagePayload) {
      return [];
    }

    const content = messagePayload.content;
    if (!this.isUnknownArray(content)) {
      return [];
    }

    return content.filter((block): block is JsonRecord => this.isJsonRecord(block));
  }

  private collectAssistantText(contentBlocks: JsonRecord[]): string {
    return contentBlocks
      .filter((block) => block.type === 'text')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .join('');
  }

  private collectReasoningText(contentBlocks: JsonRecord[]): string {
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

  private collectToolUses(contentBlocks: JsonRecord[]): ClaudeCodeToolCall[] {
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
    contentBlocks: JsonRecord[],
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
    if (this.isJsonRecord(input)) {
      return input;
    }

    return {};
  }

  private normalizeToolResultContent(content: unknown): unknown {
    if (typeof content === 'string') {
      return content;
    }

    if (!this.isUnknownArray(content)) {
      return content;
    }

    const normalized = content.map((block) => {
      if (!block || typeof block !== 'object') {
        return block;
      }

      const typedBlock = this.isJsonRecord(block) ? block : null;
      if (!typedBlock) {
        return block;
      }

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
      const parsed = this.parseJsonRecord(result.stdout);
      return {
        loggedIn: parsed?.loggedIn === true,
        authMethod: typeof parsed?.authMethod === 'string' ? parsed.authMethod : 'unknown'
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

  private toModelInfo(model: ModelSpec): ModelInfo {
    return {
      id: model.apiName,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      supportsJSON: model.capabilities.supportsJSON,
      supportsImages: model.capabilities.supportsImages,
      supportsFunctions: model.capabilities.supportsFunctions,
      supportsStreaming: model.capabilities.supportsStreaming,
      supportsThinking: model.capabilities.supportsThinking,
      pricing: {
        inputPerMillion: model.inputCostPerMillion,
        outputPerMillion: model.outputCostPerMillion,
        currency: 'USD',
        lastUpdated: new Date().toISOString()
      }
    };
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

  private async writePromptToStdin(child: DesktopChildProcess, prompt: string): Promise<void> {
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
    const errorCode = this.getProcessErrorCode(error);
    if (errorCode === 'ENAMETOOLONG' || errorCode === 'E2BIG') {
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

  private getProcessErrorCode(error: Error): string | undefined {
    const errorWithCode = error as Error & { code?: unknown };
    const maybeCode = errorWithCode.code;
    return typeof maybeCode === 'string' ? maybeCode : undefined;
  }
}
