import * as fsPromises from 'fs/promises';
import { GoogleGeminiCliAdapter } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter';

type VaultLike = {
  getName: () => string;
};

jest.mock('../../src/utils/cliProcessRunner', () => ({
  runCliProcess: jest.fn()
}));

jest.mock('../../src/utils/geminiCli', () => ({
  resolveGeminiCliRuntime: jest.fn(() => ({
    geminiPath: '/mock/bin/agy',
    nodePath: '/mock/bin/node',
    connectorPath: '/mock/connector.js',
    vaultPath: '/mock/vault',
    serverKey: 'nexus-test-vault'
  })),
  buildGeminiCliEnv: jest.fn((settingsPath: string, nodePath: string) => ({
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
    PATH: nodePath
  })),
  buildGeminiCliSystemSettings: jest.fn(() => ({
    output: { format: 'json' }
  }))
}));

describe('GoogleGeminiCliAdapter (agy plain-text contract)', () => {
  const { runCliProcess } = jest.requireMock('../../src/utils/cliProcessRunner') as {
    runCliProcess: jest.Mock;
  };

  let adapter: GoogleGeminiCliAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new GoogleGeminiCliAdapter({
      getName: () => 'Test Vault'
    } as VaultLike);
  });

  it('moves the combined prompt to stdin and normalizes the model to its agy label', async () => {
    let capturedArgs: string[] = [];
    let capturedOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdinText?: string } | undefined;
    let settingsPath = '';

    runCliProcess.mockImplementation((_command, args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      settingsPath = options?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH || '';

      expect(settingsPath).toBeTruthy();

      return {
        child: { kill: jest.fn() },
        // agy emits plain text — the response is the trimmed stdout.
        result: Promise.resolve({
          stdout: 'Antigravity output\n',
          stderr: '',
          exitCode: 0
        })
      };
    });

    const response = await adapter.generateUncached('Summarize the regression', {
      systemPrompt: 'Use the MCP tools if needed.'
    });

    // Default model slug maps fail-closed to its agy human label; no --output-format flag.
    expect(capturedArgs).toEqual([
      '--prompt',
      '',
      '--model',
      'Gemini 3.5 Flash (Medium)'
    ]);
    expect(capturedOptions?.stdinText).toBe(
      'System instructions:\nUse the MCP tools if needed.\n\nUser request:\nSummarize the regression'
    );
    expect(response.text).toBe('Antigravity output');
    // agy reports no token usage — buildLLMResponse defaults to zero.
    expect(response.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    });

    await expect(fsPromises.access(settingsPath)).rejects.toThrow();
  });

  it('returns the trimmed stdout verbatim as plain text (no JSON parsing)', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '  OK  \n',
        stderr: '',
        exitCode: 0
      })
    });

    const response = await adapter.generateUncached('Reply with OK only.', {
      model: 'gemini-3.1-flash-lite-preview'
    });

    expect(response.text).toBe('OK');
  });

  it('throws a PROVIDER_ERROR on empty/whitespace-only output', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '   \n  ',
        stderr: '',
        exitCode: 0
      })
    });

    await expect(adapter.generateUncached('Anything')).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'PROVIDER_ERROR'
    });
  });

  it('rejects an unknown model fail-closed before spawning the CLI', async () => {
    await expect(
      adapter.generateUncached('Anything', { model: 'not-a-real-model' })
    ).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'CONFIGURATION_ERROR'
    });

    expect(runCliProcess).not.toHaveBeenCalled();
  });

  it('lists only the validated Gemini CLI models', async () => {
    const models = await adapter.listModels();

    expect(models.map((model) => model.id)).toEqual([
      'gemini-3.1-flash-lite-preview',
      'gemini-3-flash-preview'
    ]);
    expect(models.map((model) => model.id)).not.toContain('gemini-3.1-pro-preview');
    expect(models.map((model) => model.id)).not.toContain('gemini-3-flash');
    expect(models.map((model) => model.id)).not.toContain('gemini-2.5-pro');
  });

  it('maps oversized CLI startup failures to REQUEST_TOO_LARGE', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '',
        stderr: 'spawn E2BIG',
        exitCode: null,
        errorCode: 'E2BIG'
      })
    });

    await expect(adapter.generateUncached('A'.repeat(100_000))).rejects.toMatchObject({
      name: 'LLMProviderError',
      provider: 'google-gemini-cli',
      code: 'REQUEST_TOO_LARGE'
    });
  });
});
