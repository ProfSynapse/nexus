import { App, Plugin, Platform } from 'obsidian';
import { ClaudeHeadlessService } from '../../src/services/external/ClaudeHeadlessService';

type ClaudeHeadlessServiceWithRunProcess = ClaudeHeadlessService & {
  runProcess: (
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
    stdinText?: string
  ) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    errorCode?: string;
  }>;
};

describe('ClaudeHeadlessService', () => {
  let service: ClaudeHeadlessService;

  beforeEach(() => {
    Platform.isDesktop = true;
    Platform.isWin = false;
    service = new ClaudeHeadlessService(
      {
        vault: {
          getName: () => 'Test Vault'
        }
      } as unknown as App,
      {
        manifest: {
          dir: '/mock/.obsidian/plugins/claudesidian-mcp'
        }
      } as unknown as Plugin
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the prompt through stdin and keeps the argv payload bounded', async () => {
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    const runProcess = jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess').mockImplementation(
      async (_command: string, args: string[], cwd?: string, _env?: NodeJS.ProcessEnv, stdinText?: string) => {
        expect(args).toEqual([
          '-p',
          '--strict-mcp-config',
          '--mcp-config',
          expect.any(String),
          '--tools',
          '',
          '--disable-slash-commands',
          '--output-format',
          'text',
          '--max-turns',
          '8',
          '--dangerously-skip-permissions',
          '--model',
          'claude-sonnet-4-6'
        ]);
        expect(stdinText).toBe('Summarize the regression');
        expect(cwd).toBe('/mock/vault');

        return {
          stdout: 'Claude output',
          stderr: '',
          exitCode: 0
        };
      }
    );

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'claude-sonnet-4-6'
    });

    expect(runProcess).toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      stdout: 'Claude output',
      stderr: '',
      exitCode: 0,
      commandLine: expect.stringContaining('--model claude-sonnet-4-6')
    });
    expect(result.commandLine).not.toContain('Summarize the regression');
  });

  it('maps local CLI transport errors to a clear failure message', async () => {
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess').mockResolvedValue({
      stdout: '',
      stderr: 'spawn E2BIG',
      exitCode: null,
      errorCode: 'E2BIG'
    });

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'claude-sonnet-4-6'
    });

    expect(result).toMatchObject({
      success: false,
      exitCode: null
    });
    expect(result.stderr).toContain('Claude headless command is too large for local CLI transport');
  });

  it('blocks oversized argv payloads on Windows before spawn', async () => {
    Platform.isWin = true;
    jest.spyOn(service, 'getPreflight').mockResolvedValue({
      claudePath: '/mock/bin/claude',
      nodePath: '/mock/bin/node',
      connectorPath: '/mock/connector.js',
      vaultPath: '/mock/vault',
      isAuthenticated: true,
      authStatusText: 'Authenticated'
    });

    const runProcess = jest.spyOn(service as ClaudeHeadlessServiceWithRunProcess, 'runProcess');

    const result = await service.run({
      prompt: 'Summarize the regression',
      model: 'x'.repeat(30_000)
    });

    expect(runProcess).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('Claude headless command is too large for Windows argv transport');
  });
});
