import { Platform } from 'obsidian';

export type ChildProcessModule = typeof import('child_process');
export type DesktopSpawnOptions = Parameters<ChildProcessModule['spawn']>[2];
export type DesktopChildProcess = ReturnType<ChildProcessModule['spawn']>;

function isWindowsCommandWrapper(command: string): boolean {
    if (!Platform.isWin) {
        return false;
    }

    const lower = command.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

export function spawnDesktopProcess(
    childProcess: ChildProcessModule,
    command: string,
    args: string[],
    options: DesktopSpawnOptions
): DesktopChildProcess {
    return childProcess.spawn(command, args, {
        ...options,
        shell: options.shell ?? isWindowsCommandWrapper(command),
        windowsHide: true
    });
}
