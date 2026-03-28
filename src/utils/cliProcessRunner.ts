/**
 * src/utils/cliProcessRunner.ts
 *
 * Shared CLI process runner for spawn-collect-resolve pattern.
 * Used by AnthropicClaudeCodeAdapter, GoogleGeminiCliAdapter, and GeminiCliAuthService.
 */
import { spawnDesktopProcess } from './desktopProcess';

type ChildProcessModuleLike = Parameters<typeof spawnDesktopProcess>[0];
type SpawnOptionsLike = Parameters<typeof spawnDesktopProcess>[3];
type SpawnedProcess = ReturnType<typeof spawnDesktopProcess>;

interface RuntimeRequire {
  <T>(moduleName: string): T;
}

interface ModuleWithRequire {
  require?: RuntimeRequire;
}

interface ProcessEnvLike {
  [key: string]: string | undefined;
}

interface ProcessErrorLike {
  message: string;
  code?: string;
}

function getGlobalValue(propertyName: string): unknown {
  return Reflect.get(globalThis as object, propertyName);
}

function isModuleWithRequire(value: unknown): value is ModuleWithRequire {
  return typeof value === 'object' && value !== null;
}

function getRuntimeRequire(): RuntimeRequire {
  const directRequire = getGlobalValue('require');
  if (typeof directRequire === 'function') {
    return directRequire as RuntimeRequire;
  }

  const moduleValue = getGlobalValue('module');
  if (isModuleWithRequire(moduleValue) && typeof moduleValue.require === 'function') {
    return moduleValue.require;
  }

  throw new Error('Node require is not available in this environment');
}

function getChildProcessModule(): ChildProcessModuleLike {
  return getRuntimeRequire()<ChildProcessModuleLike>('child_process');
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export interface CliProcessHandle {
  child: SpawnedProcess;
  result: Promise<CliProcessResult>;
}

/**
 * Spawns a CLI process and collects stdout/stderr until it exits.
 *
 * Returns both the child process reference (for abort wiring) and a
 * promise that resolves with the collected output and exit code.
 *
 * Uses `spawnDesktopProcess` for cross-platform Windows .cmd/.bat handling.
 */
export function runCliProcess(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: ProcessEnvLike;
    stdinText?: string;
  }
): CliProcessHandle {
  const childProcess = getChildProcessModule();

  const spawnOptions: SpawnOptionsLike = {
    cwd: options?.cwd,
    env: options?.env,
    stdio: options?.stdinText !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
  };

  const child = spawnDesktopProcess(childProcess, command, args, spawnOptions);

  const result = new Promise<CliProcessResult>((resolve) => {
    let settled = false;
    const resolveOnce = (value: CliProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    if (!child.stdout || !child.stderr || (options?.stdinText !== undefined && !child.stdin)) {
      resolveOnce({
        stdout: '',
        stderr: 'Failed to capture CLI process output.',
        exitCode: null
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: ProcessErrorLike) => {
      resolveOnce({
        stdout,
        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
        exitCode: null,
        errorCode: error.code
      });
    });

    child.on('close', (exitCode: number | null) => {
      resolveOnce({ stdout, stderr, exitCode });
    });

    if (options?.stdinText !== undefined) {
      const stdin = child.stdin;
      if (!stdin) {
        resolveOnce({
          stdout,
          stderr: 'Failed to open CLI stdin for prompt input.',
          exitCode: null
        });
        return;
      }

      const handleStdinError = (error: ProcessErrorLike) => {
        resolveOnce({
          stdout,
          stderr: stderr ? `${stderr}\n${error.message}` : error.message,
          exitCode: null,
          errorCode: error.code
        });
      };

      stdin.once('error', handleStdinError);
      stdin.end(options.stdinText, 'utf8', () => {
        stdin.off('error', handleStdinError);
      });
    }
  });

  return { child, result };
}
