/**
 * Discover live Nexus IPC endpoints for the standalone Node CLI.
 *
 * Unix-domain sockets are regular directory entries under /tmp. Windows named
 * pipes are visible to Windows but Node's fs.readdirSync('\\\\.\\pipe\\')
 * reports ENOTDIR, so Windows enumeration uses the built-in PowerShell file
 * system provider. The command is fixed and receives no user-controlled text.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const NAME_PREFIX = 'nexus_mcp_';
export const UNIX_SOCK_DIR = '/tmp';
export const UNIX_SUFFIX = '.sock';
export const WIN_PIPE_DIR = '\\\\.\\pipe\\';

export interface VaultSocket {
    name: string;
    path: string;
}

const WINDOWS_PIPE_LIST_SCRIPT = "Get-ChildItem -LiteralPath '\\\\.\\pipe\\' -Name";
const SAFE_PIPE_NAME = /^nexus_mcp_[a-z0-9_-]+$/;

/** Convert PowerShell's line-oriented pipe listing into validated endpoints. */
export function parseWindowsPipeListing(output: string): VaultSocket[] {
    const names = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => SAFE_PIPE_NAME.test(line));

    return [...new Set(names)]
        .sort((left, right) => left.localeCompare(right))
        .map((pipeName) => ({
            name: pipeName.slice(NAME_PREFIX.length),
            path: `${WIN_PIPE_DIR}${pipeName}`,
        }));
}

function listWindowsVaultPipes(): VaultSocket[] {
    const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PIPE_LIST_SCRIPT],
        {
            encoding: 'utf8',
            timeout: 5_000,
            windowsHide: true,
        }
    );

    if (result.error || result.status !== 0) {
        const detail = result.error?.message || String(result.stderr || '').trim() || 'unknown error';
        throw new Error(
            `Could not enumerate Windows named pipes: ${detail}. ` +
            'Pass --vault <name> or set NEXUS_VAULT as a fallback.'
        );
    }

    return parseWindowsPipeListing(String(result.stdout || ''));
}

/** A Unix socket must be owned by the current user before the CLI will expose it. */
export function isOwnUnixSocket(path: string): boolean {
    if (typeof process.getuid !== 'function') return false;
    try {
        const stat = lstatSync(path);
        return stat.isSocket() && stat.uid === process.getuid();
    } catch {
        return false;
    }
}

/** Enumerate live Nexus endpoints on the current platform. */
export function listVaultSockets(platform: NodeJS.Platform = process.platform): VaultSocket[] {
    if (platform === 'win32') {
        return listWindowsVaultPipes();
    }

    try {
        return readdirSync(UNIX_SOCK_DIR)
            .filter((fileName) => fileName.startsWith(NAME_PREFIX) && fileName.endsWith(UNIX_SUFFIX))
            .map((fileName) => ({
                name: fileName.slice(NAME_PREFIX.length, -UNIX_SUFFIX.length),
                path: `${UNIX_SOCK_DIR}/${fileName}`,
            }))
            .filter((socket) => isOwnUnixSocket(socket.path));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return [];
        throw error;
    }
}
