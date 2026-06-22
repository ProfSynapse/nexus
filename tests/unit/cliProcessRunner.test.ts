import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  runCliProcess,
  PROVIDER_TIMEOUT_ERROR_CODE,
  DEFAULT_CLI_IDLE_TIMEOUT_MS
} from '../../src/utils/cliProcessRunner';

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

describe('runCliProcess', () => {
  const { spawnDesktopProcess } = jest.requireMock('../../src/utils/desktopProcess') as {
    spawnDesktopProcess: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves existing no-stdin behavior for CLI callers', async () => {
    const child = createMockChildProcess();

    spawnDesktopProcess.mockImplementation((_childProcess, _command, _args, options) => {
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

      process.nextTick(() => {
        child.stdout.write('stdout text');
        child.stderr.write('stderr text');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });

      return child;
    });

    const handle = runCliProcess('/mock/bin/claude', ['auth', 'status'], {
      cwd: '/mock/vault'
    });

    await expect(handle.result).resolves.toEqual({
      stdout: 'stdout text',
      stderr: 'stderr text',
      exitCode: 0
    });
  });

  it('writes stdin text and switches to piped stdin when requested', async () => {
    const child = createMockChildProcess();
    const stdinChunks: string[] = [];

    child.stdin.on('data', (chunk: Buffer | string) => {
      stdinChunks.push(chunk.toString());
    });

    spawnDesktopProcess.mockImplementation((_childProcess, _command, _args, options) => {
      expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);

      process.nextTick(() => {
        child.stdout.write('{"response":"ok"}');
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });

      return child;
    });

    const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
      cwd: '/mock/vault',
      stdinText: 'Prompt from stdin'
    });

    await expect(handle.result).resolves.toEqual({
      stdout: '{"response":"ok"}',
      stderr: '',
      exitCode: 0
    });
    expect(stdinChunks.join('')).toBe('Prompt from stdin');
    expect(child.stdin.writableEnded).toBe(true);
  });

  it('captures spawn error codes for adapter-specific mapping', async () => {
    const child = createMockChildProcess();

    spawnDesktopProcess.mockReturnValue(child);

    const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
      cwd: '/mock/vault',
      stdinText: 'Prompt from stdin'
    });

    process.nextTick(() => {
      child.emit('error', Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' }));
    });

    await expect(handle.result).resolves.toEqual({
      stdout: '',
      stderr: 'spawn E2BIG',
      exitCode: null,
      errorCode: 'E2BIG'
    });
  });

  // ==========================================================================
  // Idle watchdog (issue #271, claim a)
  // A CLI that goes silent without exiting must be bounded, not hang forever.
  // ==========================================================================

  describe('idle watchdog', () => {
    it('kills a silent process and resolves PROVIDER_TIMEOUT', async () => {
      const child = createMockChildProcess();
      spawnDesktopProcess.mockReturnValue(child);

      const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
        cwd: '/mock/vault',
        stdinText: 'Prompt from stdin',
        idleTimeoutMs: 40
      });

      const result = await handle.result;

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBeNull();
      expect(result.errorCode).toBe(PROVIDER_TIMEOUT_ERROR_CODE);
      expect(result.stderr).toMatch(/no output/i);
    });

    it('resets the idle timer on output and resolves normally when the process exits', async () => {
      const child = createMockChildProcess();

      spawnDesktopProcess.mockImplementation(() => {
        // Emit output past the would-be idle window, then close normally.
        setTimeout(() => child.stdout.write('chunk one'), 25);
        setTimeout(() => child.stdout.write('chunk two'), 50);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0);
        }, 75);
        return child;
      });

      const handle = runCliProcess('/mock/bin/gemini', ['--prompt', ''], {
        cwd: '/mock/vault',
        stdinText: 'Prompt from stdin',
        idleTimeoutMs: 40
      });

      const result = await handle.result;

      // The watchdog must NOT have fired: output kept re-arming it.
      expect(child.kill).not.toHaveBeenCalled();
      expect(result.errorCode).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('chunk onechunk two');
    });

    it('exposes a generous default idle timeout', () => {
      // Guards against an accidental tightening that would regress long runs.
      expect(DEFAULT_CLI_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    });

    it('disables the watchdog when idleTimeoutMs is 0', async () => {
      const child = createMockChildProcess();

      spawnDesktopProcess.mockImplementation(() => {
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0);
        }, 60);
        return child;
      });

      const handle = runCliProcess('/mock/bin/claude', ['auth', 'status'], {
        cwd: '/mock/vault',
        idleTimeoutMs: 0
      });

      const result = await handle.result;

      expect(child.kill).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeUndefined();
    });
  });
});
