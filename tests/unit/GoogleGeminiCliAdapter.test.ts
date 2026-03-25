import * as fsPromises from 'fs/promises';
import { GoogleGeminiCliAdapter } from '../../src/services/llm/adapters/google-gemini-cli/GoogleGeminiCliAdapter';

jest.mock('../../src/utils/cliProcessRunner', () => ({
  runCliProcess: jest.fn()
}));

jest.mock('../../src/utils/geminiCli', () => ({
  resolveGeminiCliRuntime: jest.fn(() => ({
    geminiPath: '/mock/bin/gemini',
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

describe('GoogleGeminiCliAdapter', () => {
  const { runCliProcess } = jest.requireMock('../../src/utils/cliProcessRunner') as {
    runCliProcess: jest.Mock;
  };

  let adapter: GoogleGeminiCliAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new GoogleGeminiCliAdapter({
      getName: () => 'Test Vault'
    } as any);
  });

  it('moves the combined prompt to stdin while preserving temp settings and usage extraction', async () => {
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
        result: fsPromises.readFile(settingsPath, 'utf8').then((contents) => {
          expect(JSON.parse(contents)).toEqual({
            output: { format: 'json' }
          });

          return {
            stdout: JSON.stringify({
              response: 'Gemini output',
              stats: {
                models: {
                  'gemini-3-flash-preview': {
                    tokens: {
                      prompt: 12,
                      candidates: 7,
                      total: 19
                    }
                  }
                }
              }
            }),
            stderr: '',
            exitCode: 0
          };
        })
      };
    });

    const response = await adapter.generateUncached('Summarize the regression', {
      systemPrompt: 'Use the MCP tools if needed.'
    });

    expect(capturedArgs).toEqual([
      '--prompt',
      '',
      '--model',
      'gemini-3-flash-preview',
      '--output-format',
      'json'
    ]);
    expect(capturedOptions?.stdinText).toBe(
      'System instructions:\nUse the MCP tools if needed.\n\nUser request:\nSummarize the regression'
    );
    expect(response.text).toBe('Gemini output');
    expect(response.usage).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      totalTokens: 19
    });

    await expect(fsPromises.access(settingsPath)).rejects.toThrow();
  });

  it('parses CLI output with leading logs before the final JSON block', async () => {
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: [
          'Loaded cached credentials.',
          'Attempt 2 failed with status 429. Retrying with backoff...',
          '{',
          '  "response": "OK",',
          '  "stats": {',
          '    "models": {',
          '      "gemini-3.1-flash-lite-preview": {',
          '        "tokens": {',
          '          "prompt": 8045,',
          '          "candidates": 1,',
          '          "total": 8046',
          '        }',
          '      }',
          '    }',
          '  }',
          '}'
        ].join('\n'),
        stderr: '',
        exitCode: 0
      })
    });

    const response = await adapter.generateUncached('Reply with OK only.', {
      model: 'gemini-3.1-flash-lite-preview'
    });

    expect(response.text).toBe('OK');
    expect(response.usage).toEqual({
      promptTokens: 8045,
      completionTokens: 1,
      totalTokens: 8046
    });
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
    expect(models.map((model) => model.id)).not.toContain('gemini-2.5-flash');
    expect(models.map((model) => model.id)).not.toContain('gemini-2.5-flash-lite');
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
