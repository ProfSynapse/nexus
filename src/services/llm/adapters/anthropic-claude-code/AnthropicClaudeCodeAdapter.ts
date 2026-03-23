import { FileSystemAdapter, Vault } from 'obsidian';
import { BaseAdapter } from '../BaseAdapter';
import { resolveDesktopBinaryPath } from '../../../../utils/binaryDiscovery';
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
import { getAllPluginIds, getPrimaryServerKey } from '../../../../constants/branding';

type ClaudeCodeToolCall = NonNullable<StreamChunk['toolCalls']>[number];

export class AnthropicClaudeCodeAdapter extends BaseAdapter {
  readonly name = 'anthropic-claude-code';
  readonly baseUrl = 'claude-code://local';

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

    const fsPromises = require('fs/promises') as typeof import('fs/promises');
    const osMod = require('os') as typeof import('os');
    const pathMod = require('path') as typeof import('path');
    const childProcess = require('child_process') as typeof import('child_process');
    const readline = require('readline') as typeof import('readline');

    const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-claude-code-adapter-'));
    const mcpConfigPath = pathMod.join(tempDir, 'mcp.json');
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
        'stream-json',
        '--max-turns',
        String(Math.max(1, options?.maxTokens ? Math.min(12, Math.ceil(options.maxTokens / 8000)) : 8))
      ];

      if (options?.systemPrompt?.trim()) {
        args.push('--append-system-prompt', options.systemPrompt.trim());
      }

      if (options?.enableThinking && options?.thinkingEffort) {
        args.push('--effort', options.thinkingEffort);
      }

      const model = options?.model || this.currentModel;
      if (model) {
        args.push('--model', model);
      }

      args.push(prompt);

      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = childProcess.spawn(runtime.claudePath, args, {
        cwd: runtime.vaultPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const closePromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
          resolve({ exitCode, signal });
        });
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

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
    const vaultPath = this.getVaultBasePath();

    if (!nodePath) {
      throw new LLMProviderError('Node.js was not found on PATH.', this.name, 'CONFIGURATION_ERROR');
    }

    return {
      claudePath,
      nodePath,
      connectorPath: this.getConnectorPath(vaultPath),
      vaultPath
    };
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

    const normalized = content.map((block) => {
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

  private getVaultBasePath(): string | null {
    const adapter = this.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  private getConnectorPath(vaultPath: string | null): string | null {
    if (!vaultPath) {
      return null;
    }

    const pathMod = require('path') as typeof import('path');
    const nodeFs = require('fs') as typeof import('fs');

    for (const pluginId of getAllPluginIds()) {
      const candidate = pathMod.join(vaultPath, '.obsidian', 'plugins', pluginId, 'connector.js');
      if (nodeFs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private async readAuthStatus(claudePath: string, cwd: string): Promise<{ loggedIn: boolean; authMethod: string }> {
    const result = await this.runProcess(claudePath, ['auth', 'status'], cwd);
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

  private async runProcess(
    command: string,
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const childProcess = require('child_process') as typeof import('child_process');

    return await new Promise((resolve) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;

      const child = childProcess.spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (error: Error) => {
        resolve({
          stdout,
          stderr: stderr ? `${stderr}\n${error.message}` : error.message,
          exitCode: null
        });
      });

      child.on('close', (exitCode: number | null) => {
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}
