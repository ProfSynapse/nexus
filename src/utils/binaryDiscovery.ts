import { Platform } from 'obsidian';

type DesktopModuleMap = {
    child_process: typeof import('child_process');
    fs: typeof import('fs');
    path: typeof import('path');
};

type NodeFs = DesktopModuleMap['fs'];
type PathModule = DesktopModuleMap['path'];

const COMMON_UNIX_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];

// Per-user install locations (version managers, user-level installers). GUI apps launched
// from a desktop session usually don't inherit the PATH these tools set up in shell rc files.
// Relative to $HOME; nvm is handled separately because its bin dir is versioned.
const USER_UNIX_BIN_DIRS = [
    '.volta/bin',
    '.local/share/fnm/aliases/default/bin',
    '.fnm/aliases/default/bin',
    '.asdf/shims',
    '.local/share/mise/shims',
    '.local/bin'
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

    const maybeRequire = (window.activeWindow as Window & {
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
        const binDirs = Platform.isWin
            ? getCommonWindowsBinDirs()
            : [...COMMON_UNIX_BIN_DIRS, ...getUserUnixBinDirs(nodeFs, pathMod)];
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

function getUserUnixBinDirs(nodeFs: NodeFs, pathMod: PathModule): string[] {
    const home = process.env.HOME;
    if (!home) {
        return [];
    }

    const nvmBinDir = getNewestNvmBinDir(nodeFs, pathMod, process.env.NVM_DIR || pathMod.join(home, '.nvm'));
    return [
        ...(nvmBinDir ? [nvmBinDir] : []),
        ...USER_UNIX_BIN_DIRS.map((dir) => pathMod.join(home, dir))
    ];
}

function getNewestNvmBinDir(nodeFs: NodeFs, pathMod: PathModule, nvmDir: string): string | null {
    try {
        const versionsDir = pathMod.join(nvmDir, 'versions', 'node');
        const newest = nodeFs.readdirSync(versionsDir)
            .map((name) => ({ name, parts: parseNodeVersion(name) }))
            .filter((entry): entry is { name: string; parts: number[] } => entry.parts !== null)
            .sort((a, b) => compareVersionParts(b.parts, a.parts))[0];
        return newest ? pathMod.join(versionsDir, newest.name, 'bin') : null;
    } catch {
        return null;
    }
}

function parseNodeVersion(name: string): number[] | null {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name);
    return match ? match.slice(1).map(Number) : null;
}

function compareVersionParts(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

function resolveFromLoginShell(binaryName: string): string | null {
    if (!Platform.isDesktop || Platform.isWin) {
        return null;
    }

    // A non-interactive login shell skips rc files (and bash's default .bashrc returns early
    // when non-interactive), which is where nvm and similar tools usually set up PATH.
    // Retry as an interactive login shell before giving up.
    return resolveFromShell(binaryName, '-lc') ?? resolveFromShell(binaryName, '-ilc');
}

function resolveFromShell(binaryName: string, shellFlags: '-lc' | '-ilc'): string | null {
    try {
        const childProcess = loadDesktopModule('child_process');
        const nodeFs = loadDesktopModule('fs');
        const shell = process.env.SHELL || '/bin/zsh';
        const escapedBinaryName = binaryName.replace(/'/g, `'\\''`);
        const result = childProcess.execFileSync(
            shell,
            [shellFlags, `command -v '${escapedBinaryName}'`],
            {
                encoding: 'utf8',
                timeout: 5000,
                env: { ...process.env }
            }
        );

        // Interactive shells can print banners or warnings around the answer, so take the
        // last line that is an existing absolute path rather than trusting the first line.
        const candidate = String(result)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.startsWith('/'))
            .pop();
        if (candidate && nodeFs.existsSync(candidate)) {
            return candidate;
        }
    } catch {
        // No resolution from this shell mode.
    }

    return null;
}
