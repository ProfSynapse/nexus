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

const STATIC_COMMON_WINDOWS_BIN_DIRS = [
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

        const lines = result
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const preferredLine = Platform.isWin
            ? lines.find((line) => isWindowsCommandWrapperPath(line) && nodeFs.existsSync(line))
            : null;

        if (preferredLine) {
            return preferredLine;
        }

        for (const line of lines) {
            if (nodeFs.existsSync(line)) {
                return line;
            }
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
        const binDirs = Platform.isWin ? getCommonWindowsBinDirs() : COMMON_UNIX_BIN_DIRS;
        const candidateNames = Platform.isWin
            ? [`${binaryName}.cmd`, `${binaryName}.bat`, `${binaryName}.exe`, binaryName]
            : [binaryName];

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

function isWindowsCommandWrapperPath(path: string): boolean {
    return /\.(cmd|bat)$/i.test(path);
}

function getCommonWindowsBinDirs(): string[] {
    return [
        process.env.APPDATA ? `${process.env.APPDATA}\\npm` : null,
        ...STATIC_COMMON_WINDOWS_BIN_DIRS
    ].filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
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
