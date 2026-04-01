import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fsPromises from 'fs/promises';
import { Platform } from 'obsidian';
import { AnthropicClaudeCodeAdapter } from '../../src/services/llm/adapters/anthropic-claude-code/AnthropicClaudeCodeAdapter';

type VaultLike = {
  getName: () => string;
};

jest.mock('../../src/utils/binaryDiscovery', () => ({
  resolveDesktopBinaryPath: jest.fn((binary: string) => `/mock/bin/${binary}`)
}));

jest.mock('../../src/utils/cliPathUtils', () => ({
  getVaultBasePath: jest.fn(() => '/mock/vault'),
  getConnectorPath: jest.fn(() => '/mock/connector.js')
}));

jest.mock('../../src/utils/cliProcessRunner', () => ({
  runCliProcess: jest.fn(() => ({
    child: { kill: jest.fn() },
    result: Promise.resolve({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth' }),
      stderr: '',
      exitCode: 0
    })
  }))
}));

jest.mock('../../src/utils/desktopProcess', () => ({
  spawnDesktopProcess: jest.fn()
}));

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: jest.Mock;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  return child;
}

describe('AnthropicClaudeCodeAdapter', () => {
  const { spawnDesktopProcess } = jest.requireMock('../../src/utils/desktopProcess') as {
    spawnDesktopProcess: jest.Mock;
  };

  let adapter: AnthropicClaudeCodeAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    Platform.isWin = false;
    adapter = new AnthropicClaudeCodeAdapter({
      getName: () => 'Test Vault'
    } as VaultLike);
  });

  it('writes the system prompt to a temp file and sends the user prompt through stdin', async () => {
    const child = createMockChildProcess();
    const stdinChunks: string[] = [];
    let capturedArgs: string[] = [];
    let systemPromptContents = '';

    child.stdin.on('data', (chunk: Buffer | string) => {
      stdinChunks.push(chunk.toString());
    });

    spawnDesktopProcess.mockImplementation((_childProcess, _command, args) => {
      capturedArgs = args;
      const systemPromptIndex = args.indexOf('--append-system-prompt-file');
      const systemPromptPath = systemPromptIndex >= 0 ? args[systemPromptIndex + 1] : '';

      process.nextTick(async () => {
        systemPromptContents = systemPromptPath
          ? await fsPromises.readFile(systemPromptPath, 'utf8')
          : '';
        child.stdout.write(JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello from Claude Code' }]
          }
        }) + '\n');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });

      return child;
    });

    const chunks = [];
    for await (const chunk of adapter.generateStreamAsync('Explain the bug', {
      systemPrompt: 'Use the workspace notes'
    })) {
      chunks.push(chunk);
    }

    expect(capturedArgs).toContain('--append-system-prompt-file');
    expect(capturedArgs).not.toContain('--append-system-prompt');
    expect(capturedArgs).not.toContain('Use the workspace notes');
    expect(capturedArgs).not.toContain('Explain the bug');
    expect(systemPromptContents).toBe('Use the workspace notes');
    expect(stdinChunks.join('')).toBe('Explain the bug');
    expect(chunks.some((chunk) => chunk.content === 'Hello from Claude Code')).toBe(true);
  });

  it('cleans up temp files after a successful run', async () => {
    const child = createMockChildProcess();
    let mcpConfigPath = '';
    let systemPromptPath = '';

    spawnDesktopProcess.mockImplementation((_childProcess, _command, args) => {
      const configIndex = args.indexOf('--mcp-config');
      mcpConfigPath = configIndex >= 0 ? args[configIndex + 1] : '';
      const systemPromptIndex = args.indexOf('--append-system-prompt-file');
      systemPromptPath = systemPromptIndex >= 0 ? args[systemPromptIndex + 1] : '';

      process.nextTick(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });

      return child;
    });

    for await (const _chunk of adapter.generateStreamAsync('Short prompt', {
      systemPrompt: 'Short system prompt'
    })) {
      void _chunk;
    }

    await expect(fsPromises.access(mcpConfigPath)).rejects.toThrow();
    await expect(fsPromises.access(systemPromptPath)).rejects.toThrow();
  });

  it('allows large system prompts on Windows because they are written to a temp file', async () => {
    Platform.isWin = true;
    const oversizedSystemPrompt = 'A'.repeat(40_000);
    const child = createMockChildProcess();
    let capturedSystemPrompt = '';

    spawnDesktopProcess.mockImplementation((_childProcess, _command, args) => {
      const systemPromptIndex = args.indexOf('--append-system-prompt-file');
      const systemPromptPath = systemPromptIndex >= 0 ? args[systemPromptIndex + 1] : '';

      process.nextTick(async () => {
        capturedSystemPrompt = await fsPromises.readFile(systemPromptPath, 'utf8');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0, null);
      });

      return child;
    });

    for await (const _chunk of adapter.generateStreamAsync('Explain the bug', {
      systemPrompt: oversizedSystemPrompt
    })) {
      void _chunk;
    }

    expect(spawnDesktopProcess).toHaveBeenCalledTimes(1);
    expect(capturedSystemPrompt).toBe(oversizedSystemPrompt);
  });

  it('still blocks oversized remaining argv on Windows before spawn', async () => {
    Platform.isWin = true;
    const oversizedModel = 'A'.repeat(40_000);

    await expect(async () => {
      for await (const _chunk of adapter.generateStreamAsync('Explain the bug', {
        model: oversizedModel
      })) {
        void _chunk;
      }
    }).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'anthropic-claude-code',
      code: 'REQUEST_TOO_LARGE'
    });

    expect(spawnDesktopProcess).not.toHaveBeenCalled();
  });
});
