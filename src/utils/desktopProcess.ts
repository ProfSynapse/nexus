import { Platform } from 'obsidian';

type ChildProcessModule = typeof import('child_process');
type SpawnOptions = import('child_process').SpawnOptions;

function isWindowsCommandWrapper(command: string): boolean {
    return Platform.isWin && /\.(cmd|bat)$/iu.test(command);
}

export function spawnDesktopProcess(
    childProcess: ChildProcessModule,
    command: string,
    args: string[],
    options: SpawnOptions
) {
    return childProcess.spawn(command, args, {
        ...options,
        shell: options.shell ?? isWindowsCommandWrapper(command),
        windowsHide: true
    });
}
