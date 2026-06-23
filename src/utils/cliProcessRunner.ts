/**
 * src/utils/cliProcessRunner.ts
 *
 * Shared CLI process runner for spawn-collect-resolve pattern.
 * Used by AnthropicClaudeCodeAdapter, GoogleGeminiCliAdapter, and GeminiCliAuthService.
 */
import { Platform } from 'obsidian';
import { spawnDesktopProcess, type DesktopChildProcess, type DesktopSpawnOptions } from './desktopProcess';

type CliProcessRunnerDesktopModuleMap = {
  child_process: typeof import('child_process');
};

function loadDesktopModule<TModuleName extends keyof CliProcessRunnerDesktopModuleMap>(
  moduleName: TModuleName
): CliProcessRunnerDesktopModuleMap[TModuleName] {
  if (!Platform.isDesktop) {
    throw new Error(`${moduleName} is only available on desktop.`);
  }

  const maybeRequire = (window.activeWindow as Window & {
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
  child: DesktopChildProcess;
  result: Promise<CliProcessResult>;
}

/**
 * Default idle (inactivity) timeout for CLI processes, in milliseconds.
 *
 * This is an INACTIVITY watchdog, not a hard total-runtime cap: the timer is
 * reset every time the process emits stdout/stderr, so a legitimately long
 * local generation that keeps streaming output is never cut off. It only fires
 * when the process goes silent for this long without exiting — the wedged-CLI
 * case that left the chat spinner stuck forever (issue #271, claim a).
 *
 * 120s of silence is deliberately generous: local CLIs (gemini, Claude Code)
 * can pause between planner/tool phases, and an idle timer that is too tight
 * would regress those legitimate gaps. A truly hung process is still bounded.
 */
export const DEFAULT_CLI_IDLE_TIMEOUT_MS = 120_000;

/**
 * Error code surfaced when the idle watchdog kills a silent CLI process.
 *
 * Follows the inline string-literal convention used for `LLMProviderError.code`
 * across the adapters (e.g. `PROVIDER_ERROR`, `CONFIGURATION_ERROR`). Adapters
 * map this code to a user-visible `LLMProviderError`.
 */
export const PROVIDER_TIMEOUT_ERROR_CODE = 'PROVIDER_TIMEOUT';

/**
 * Spawns a CLI process and collects stdout/stderr until it exits.
 *
 * Returns both the child process reference (for abort wiring) and a
 * promise that resolves with the collected output and exit code.
 *
 * An idle watchdog (see `idleTimeoutMs` / `DEFAULT_CLI_IDLE_TIMEOUT_MS`) bounds
 * a process that goes silent without exiting: it is killed and the promise
 * RESOLVES with `errorCode: PROVIDER_TIMEOUT_ERROR_CODE` (never rejects, so
 * existing callers keep their resolve-only contract). The timer resets on every
 * stdout/stderr chunk, so actively-streaming processes are not interrupted.
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
    /**
     * Inactivity timeout in milliseconds. The watchdog fires only after this
     * long with NO stdout/stderr output. Defaults to
     * `DEFAULT_CLI_IDLE_TIMEOUT_MS`. Pass `0` or a negative value to disable.
     */
    idleTimeoutMs?: number;
  }
): CliProcessHandle {
  const childProcess = loadDesktopModule('child_process');

  const spawnOptions: DesktopSpawnOptions = {
    cwd: options?.cwd,
    env: options?.env,
    stdio: options?.stdinText !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
  };

  const child = spawnDesktopProcess(childProcess, command, args, spawnOptions);

  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_CLI_IDLE_TIMEOUT_MS;
  const idleWatchdogEnabled = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0;

  const result = new Promise<CliProcessResult>((resolve) => {
    let settled = false;
    let idleTimer: number | undefined;

    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        window.clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const resolveOnce = (value: CliProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
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

    // Idle (inactivity) watchdog: fires only after `idleTimeoutMs` with no
    // output. Each stdout/stderr chunk re-arms it, so a streaming process is
    // never cut off — only a wedged, silent one. On fire we kill the child and
    // RESOLVE with PROVIDER_TIMEOUT (keeping the resolve-only contract); the
    // subsequent 'close'/'error' event is a no-op because `settled` is set.
    const handleIdleTimeout = () => {
      if (settled) {
        return;
      }
      try {
        child.kill();
      } catch {
        // Best-effort kill; the resolve below still unblocks the awaiter.
      }
      const timeoutSeconds = Math.round(idleTimeoutMs / 1000);
      const timeoutNotice = `CLI process produced no output for ${timeoutSeconds}s and was terminated.`;
      resolveOnce({
        stdout,
        stderr: stderr ? `${stderr}\n${timeoutNotice}` : timeoutNotice,
        exitCode: null,
        errorCode: PROVIDER_TIMEOUT_ERROR_CODE
      });
    };

    const armIdleTimer = () => {
      if (!idleWatchdogEnabled || settled) {
        return;
      }
      clearIdleTimer();
      idleTimer = window.setTimeout(handleIdleTimeout, idleTimeoutMs);
    };

    // Arm immediately so a process that never emits anything is still bounded.
    armIdleTimer();

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      armIdleTimer();
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      armIdleTimer();
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
