/**
 * src/utils/cliProcessRunner.ts
 *
 * Shared CLI process runner for spawn-collect-resolve pattern.
 * Used by AnthropicClaudeCodeAdapter, GoogleGeminiCliAdapter, and GeminiCliAuthService.
 */
/* eslint-disable import/no-nodejs-modules -- desktop-only CLI process runner uses Node child_process in Electron */
import { Platform } from 'obsidian';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawnDesktopProcess } from './desktopProcess';

type CliProcessRunnerDesktopModuleMap = {
  child_process: typeof import('child_process');
};

function loadDesktopModule<TModuleName extends keyof CliProcessRunnerDesktopModuleMap>(
  moduleName: TModuleName
): CliProcessRunnerDesktopModuleMap[TModuleName] {
  if (!Platform.isDesktop) {
    throw new Error(`${moduleName} is only available on desktop.`);
  }

  const maybeRequire = (globalThis as typeof globalThis & {
    require?: (moduleId: string) => unknown;
  }).require;

  if (typeof maybeRequire !== 'function') {
    throw new Error('Desktop module loader is unavailable.');
  }

  return maybeRequire(moduleName) as CliProcessRunnerDesktopModuleMap[TModuleName];
}

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
}

export interface CliProcessHandle {
  child: ChildProcess;
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
    env?: NodeJS.ProcessEnv;
    stdinText?: string;
  }
): CliProcessHandle {
  const childProcess = loadDesktopModule('child_process');

  const spawnOptions: SpawnOptions = {
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

    child.on('error', (error: NodeJS.ErrnoException) => {
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

      const handleStdinError = (error: NodeJS.ErrnoException) => {
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
