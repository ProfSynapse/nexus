import { Platform } from 'obsidian';

type ChildProcessModule = {
    execSync(command: string, options: CommandExecutionOptions): string;
    execFileSync(file: string, args: string[], options: CommandExecutionOptions): string;
};

type FsModule = {
    existsSync(path: string): boolean;
};

type PathModule = {
    join(...paths: string[]): string;
};

type DesktopModuleMap = {
    child_process: ChildProcessModule;
    fs: FsModule;
    path: PathModule;
};

type DesktopRuntime = {
    childProcess: ChildProcessModule;
    nodeFs: FsModule;
    nodePath: PathModule;
};

type RuntimeRequire = <K extends keyof DesktopModuleMap>(moduleName: K) => DesktopModuleMap[K];

type EnvironmentVariables = Record<string, string | undefined>;

type CommandExecutionOptions = {
    encoding: 'utf8';
    timeout: number;
    env: EnvironmentVariables;
};

type ModuleWithRequire = {
    require: RuntimeRequire;
};

let cachedDesktopRuntime: DesktopRuntime | null | undefined;

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

function getDesktopRuntime(): DesktopRuntime | null {
    if (!Platform.isDesktop) {
        return null;
    }

    if (cachedDesktopRuntime !== undefined) {
        return cachedDesktopRuntime;
    }

    const runtimeRequire = getRuntimeRequire();
    if (!runtimeRequire) {
        cachedDesktopRuntime = null;
        return null;
    }

    try {
        cachedDesktopRuntime = {
            childProcess: runtimeRequire('child_process'),
            nodeFs: runtimeRequire('fs'),
            nodePath: runtimeRequire('path')
        };
    } catch {
        cachedDesktopRuntime = null;
    }

    return cachedDesktopRuntime;
}

function getRuntimeRequire(): RuntimeRequire | null {
    const globalRequire = getGlobalValue('require');
    if (typeof globalRequire === 'function') {
        return globalRequire as RuntimeRequire;
    }

    const runtimeModule = getGlobalValue('module');
    if (isModuleWithRequire(runtimeModule)) {
        return runtimeModule.require;
    }

    return null;
}

function getGlobalValue(propertyName: string): unknown {
    return (globalThis as Record<string, unknown>)[propertyName];
}

function isModuleWithRequire(value: unknown): value is ModuleWithRequire {
    if (typeof value !== 'object' || value === null || !('require' in value)) {
        return false;
    }

    return typeof value.require === 'function';
}

function resolveFromCurrentPath(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    const runtime = getDesktopRuntime();
    if (!runtime) {
        return null;
    }

    try {
        const command = Platform.isWin ? `where ${binaryName}` : `which ${binaryName}`;
        const result = runtime.childProcess.execSync(command, {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env }
        }).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && runtime.nodeFs.existsSync(firstLine)) {
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

    const runtime = getDesktopRuntime();
    if (!runtime) {
        return null;
    }

    try {
        const binDirs = Platform.isWin ? COMMON_WINDOWS_BIN_DIRS : COMMON_UNIX_BIN_DIRS;
        const candidateNames = Platform.isWin ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`] : [binaryName];

        for (const dir of binDirs) {
            for (const candidateName of candidateNames) {
                const candidate = runtime.nodePath.join(dir, candidateName);
                if (runtime.nodeFs.existsSync(candidate)) {
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

    const runtime = getDesktopRuntime();
    if (!runtime) {
        return null;
    }

    try {
        const shell = process.env.SHELL || '/bin/zsh';
        const escapedBinaryName = binaryName.replace(/'/g, `'\\''`);
        const result = runtime.childProcess.execFileSync(
            shell,
            ['-lc', `command -v '${escapedBinaryName}'`],
            {
                encoding: 'utf8',
                timeout: 5000,
                env: { ...process.env }
            }
        ).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && runtime.nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // No login-shell resolution available.
    }

    return null;
}
