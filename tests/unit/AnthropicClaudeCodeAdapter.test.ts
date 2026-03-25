import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fsPromises from 'fs/promises';
import { Platform } from 'obsidian';
import { AnthropicClaudeCodeAdapter } from '../../src/services/llm/adapters/anthropic-claude-code/AnthropicClaudeCodeAdapter';

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
    } as any);
  });

  it('keeps the appended system prompt on argv and sends the user prompt through stdin', async () => {
    const child = createMockChildProcess();
    const stdinChunks: string[] = [];
    let capturedArgs: string[] = [];

    child.stdin.on('data', (chunk: Buffer | string) => {
      stdinChunks.push(chunk.toString());
    });

    spawnDesktopProcess.mockImplementation((_childProcess, _command, args) => {
      capturedArgs = args;

      process.nextTick(() => {
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

    expect(capturedArgs).toContain('--append-system-prompt');
    expect(capturedArgs).toContain('Use the workspace notes');
    expect(capturedArgs).not.toContain('--system-prompt-file');
    expect(capturedArgs).not.toContain('--append-system-prompt-file');
    expect(capturedArgs).not.toContain('Explain the bug');
    expect(stdinChunks.join('')).toBe('Explain the bug');
    expect(chunks.some((chunk) => chunk.content === 'Hello from Claude Code')).toBe(true);
  });

  it('cleans up temp files after a successful run', async () => {
    const child = createMockChildProcess();
    let mcpConfigPath = '';

    spawnDesktopProcess.mockImplementation((_childProcess, _command, args) => {
      const configIndex = args.indexOf('--mcp-config');
      mcpConfigPath = configIndex >= 0 ? args[configIndex + 1] : '';

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
      // drain
    }

    await expect(fsPromises.access(mcpConfigPath)).rejects.toThrow();
  });

  it('blocks oversized appended system prompts on Windows before spawn', async () => {
    Platform.isWin = true;
    const oversizedSystemPrompt = 'A'.repeat(40_000);

    await expect(async () => {
      for await (const _chunk of adapter.generateStreamAsync('Explain the bug', {
        systemPrompt: oversizedSystemPrompt
      })) {
        // drain
      }
    }).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'anthropic-claude-code',
      code: 'REQUEST_TOO_LARGE'
    });

    expect(spawnDesktopProcess).not.toHaveBeenCalled();
  });
});
