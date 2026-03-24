/**
 * src/utils/cliProcessRunner.ts
 *
 * Shared CLI process runner for spawn-collect-resolve pattern.
 * Used by AnthropicClaudeCodeAdapter, GoogleGeminiCliAdapter, and GeminiCliAuthService.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawnDesktopProcess } from './desktopProcess';

export interface CliProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
  }
): CliProcessHandle {
  const childProcess = require('child_process') as typeof import('child_process');

  const spawnOptions: SpawnOptions = {
    cwd: options?.cwd,
    env: options?.env,
    stdio: ['ignore', 'pipe', 'pipe']
  };

  const child = spawnDesktopProcess(childProcess, command, args, spawnOptions);

  const result = new Promise<CliProcessResult>((resolve) => {
    if (!child.stdout || !child.stderr) {
      resolve({
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

  return { child, result };
}
