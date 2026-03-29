import { Platform } from 'obsidian';

type ChildProcessModule = typeof import('child_process');
type SpawnOptions = import('child_process').SpawnOptions;

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
    options: SpawnOptions
): ReturnType<ChildProcessModule['spawn']> {
    return childProcess.spawn(command, args, {
        ...options,
        shell: options.shell ?? isWindowsCommandWrapper(command),
        windowsHide: true
    });
}
