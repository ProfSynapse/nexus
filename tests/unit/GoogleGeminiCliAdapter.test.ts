import { Platform } from 'obsidian';
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
    vaultPath: '/mock/vault'
  })),
  // Slice d: buildGeminiCliEnv takes only nodePath; no system-settings path.
  buildGeminiCliEnv: jest.fn((nodePath: string) => ({
    PATH: nodePath
  }))
}));

describe('GoogleGeminiCliAdapter (agy slice-d invocation)', () => {
  const { runCliProcess } = jest.requireMock('../../src/utils/cliProcessRunner') as {
    runCliProcess: jest.Mock;
  };

  // Platform.isMacOS is mutated by the sandbox-guard test; restore it after each.
  const mutablePlatform = Platform as unknown as { isMacOS: boolean };
  const originalIsMacOS = mutablePlatform.isMacOS;

  let adapter: GoogleGeminiCliAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mutablePlatform.isMacOS = originalIsMacOS;
    adapter = new GoogleGeminiCliAdapter({
      getName: () => 'Test Vault'
    } as VaultLike);
  });

  afterEach(() => {
    mutablePlatform.isMacOS = originalIsMacOS;
  });

  it('invokes agy with print/model/print-timeout/sandbox and the prompt on stdin', async () => {
    // The obsidian test mock sets Platform.isMacOS = true, so --sandbox is passed.
    let capturedArgs: string[] = [];
    let capturedOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdinText?: string } | undefined;

    runCliProcess.mockImplementation((_command, args, options) => {
      capturedArgs = args;
      capturedOptions = options;
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

    // Default model slug maps fail-closed to its agy human label; no config write,
    // no --output-format, no --dangerously-skip-permissions. --print-timeout is a
    // Go-duration string (NOT ms). --sandbox is present on darwin.
    expect(capturedArgs).toEqual([
      '--print',
      '--model',
      'Gemini 3.5 Flash (Medium)',
      '--print-timeout',
      '60s',
      '--sandbox'
    ]);
    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
    expect(capturedOptions?.cwd).toBe('/mock/vault');
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
  });

  it('writes no temp settings file and threads no settings-path env (Scenario A)', async () => {
    // Scenario A = zero persistent/temp config footprint. The old gemini runtime
    // wrote a temp system-settings.json (via mkdtemp/writeFile) and pointed agy at
    // it with GEMINI_CLI_SYSTEM_SETTINGS_PATH. That flow must be entirely gone:
    // no settings-path env var, and no --output-format / settings args.
    let capturedArgs: string[] = [];
    let capturedOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdinText?: string } | undefined;

    runCliProcess.mockImplementation((_command, args, options) => {
      capturedArgs = args;
      capturedOptions = options;
      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 })
      };
    });

    await adapter.generateUncached('Anything');

    // No settings-path env var is threaded to the child process.
    expect(capturedOptions?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBeUndefined();
    // No JSON-output / settings-injection args survive from the gemini runtime.
    expect(capturedArgs).not.toContain('--output-format');
    expect(capturedArgs.some((arg) => arg.includes('system-settings'))).toBe(false);
    expect(capturedArgs.some((arg) => arg.includes('.json'))).toBe(false);
  });

  it('omits --sandbox on non-darwin platforms (platform guard)', async () => {
    mutablePlatform.isMacOS = false;
    let capturedArgs: string[] = [];

    runCliProcess.mockImplementation((_command, args) => {
      capturedArgs = args;
      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 })
      };
    });

    await adapter.generateUncached('Anything');

    expect(capturedArgs).not.toContain('--sandbox');
    // The security floor (print/model/print-timeout, no skip-perms) still holds.
    expect(capturedArgs).toEqual([
      '--print',
      '--model',
      'Gemini 3.5 Flash (Medium)',
      '--print-timeout',
      '60s'
    ]);
    expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
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

  it('preserves internal newlines in a multi-paragraph response (trim strips only the edges)', async () => {
    // The common real agy response is multi-line/multi-paragraph. parseAgyOutput
    // is stdout.trim(), so leading/trailing whitespace is stripped but INTERNAL
    // newlines (incl. the blank line between paragraphs) must be preserved verbatim.
    runCliProcess.mockReturnValue({
      child: { kill: jest.fn() },
      result: Promise.resolve({
        stdout: '\n  Line one.\n\nLine two.\n  ',
        stderr: '',
        exitCode: 0
      })
    });

    const response = await adapter.generateUncached('Write two short paragraphs.');

    expect(response.text).toBe('Line one.\n\nLine two.');
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

  it('lists exactly the 2 BASE Gemini models (effort comes from the slider)', async () => {
    const models = await adapter.listModels();

    // Mirrors GoogleGeminiCliModels.ts: just the 2 base models. Effort is NOT a
    // catalog entry anymore — it comes from the thinking/effort slider and is
    // composed into the agy label at invocation. Gemini-only.
    expect(models.map((model) => model.id)).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro'
    ]);
    // The retired effort-variant slugs are NOT catalog entries (they survive only
    // as normalize aliases for settings-compat, not as listable models).
    expect(models.map((model) => model.id)).not.toContain('gemini-3.5-flash-low');
    expect(models.map((model) => model.id)).not.toContain('gemini-3.5-flash-medium');
    expect(models.map((model) => model.id)).not.toContain('gemini-3.1-pro-high');
    // Legacy *-preview slugs are likewise normalize-only aliases.
    expect(models.map((model) => model.id)).not.toContain('gemini-3-flash-preview');
    // Stale specs that were never part of this provider's catalog.
    expect(models.map((model) => model.id)).not.toContain('gemini-2.5-pro');
  });

  it('composes the agy --model label from the base model + the effort slider', async () => {
    let capturedArgs: string[] = [];
    runCliProcess.mockImplementation((_command, args) => {
      capturedArgs = args;
      return {
        child: { kill: jest.fn() },
        result: Promise.resolve({ stdout: 'ok', stderr: '', exitCode: 0 })
      };
    });

    // Base Flash + slider High → "Gemini 3.5 Flash (High)".
    await adapter.generateUncached('x', { model: 'gemini-3.5-flash', thinkingEffort: 'high' });
    expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (High)');

    // Pro + slider Medium → clamps UP to "Gemini 3.1 Pro (High)" (Pro lacks Medium).
    await adapter.generateUncached('x', { model: 'gemini-3.1-pro', thinkingEffort: 'medium' });
    expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('Gemini 3.1 Pro (High)');

    // A saved legacy effort-variant slug still resolves (explicit effort wins).
    await adapter.generateUncached('x', { model: 'gemini-3.5-flash-low', thinkingEffort: 'high' });
    expect(capturedArgs[capturedArgs.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Low)');
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
