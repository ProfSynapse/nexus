import { Platform } from 'obsidian';

type DesktopModuleMap = {
    child_process: typeof import('child_process');
    fs: typeof import('fs');
    path: typeof import('path');
};

const COMMON_UNIX_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];

const COMMON_WINDOWS_BIN_DIRS = [
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Claude',
    'C:\\Program Files\\Anthropic\\Claude'
];

function loadDesktopModule<TModuleName extends keyof DesktopModuleMap>(
    moduleName: TModuleName
): DesktopModuleMap[TModuleName] {
    if (!Platform.isDesktop) {
        throw new Error(`${moduleName} is only available on desktop.`);
    }

    const maybeRequire = (globalThis as typeof globalThis & {
        require?: (moduleId: string) => unknown;
    }).require;

    if (typeof maybeRequire !== 'function') {
        throw new Error('Desktop module loader is unavailable.');
    }

    return maybeRequire(moduleName) as DesktopModuleMap[TModuleName];
}

export function resolveDesktopBinaryPath(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    const fromPath = resolveFromCurrentPath(binaryName);
    if (fromPath) {
        return fromPath;
    }

    const fromCommonLocations = resolveFromCommonLocations(binaryName);
    if (fromCommonLocations) {
        return fromCommonLocations;
    }

    return resolveFromLoginShell(binaryName);
}

function resolveFromCurrentPath(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    try {
        const childProcess = loadDesktopModule('child_process');
        const nodeFs = loadDesktopModule('fs');
        const command = Platform.isWin ? `where ${binaryName}` : `which ${binaryName}`;
        const result = childProcess.execSync(command, {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env }
        }).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // Fall through to deterministic location checks.
    }

    return null;
}

function resolveFromCommonLocations(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    try {
        const nodeFs = loadDesktopModule('fs');
        const pathMod = loadDesktopModule('path');
        const binDirs = Platform.isWin ? COMMON_WINDOWS_BIN_DIRS : COMMON_UNIX_BIN_DIRS;
        const candidateNames = Platform.isWin ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`] : [binaryName];

        for (const dir of binDirs) {
            for (const candidateName of candidateNames) {
                const candidate = pathMod.join(dir, candidateName);
                if (nodeFs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    } catch {
        // Fall through to shell lookup.
    }

    return null;
}

function resolveFromLoginShell(binaryName: string): string | null {
    if (!Platform.isDesktop || Platform.isWin) {
        return null;
    }

    try {
        const childProcess = loadDesktopModule('child_process');
        const nodeFs = loadDesktopModule('fs');
        const shell = process.env.SHELL || '/bin/zsh';
        const escapedBinaryName = binaryName.replace(/'/g, `'\\''`);
        const result = childProcess.execFileSync(
            shell,
            ['-lc', `command -v '${escapedBinaryName}'`],
            {
                encoding: 'utf8',
                timeout: 5000,
                env: { ...process.env }
            }
        ).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // No login-shell resolution available.
    }

    return null;
}
