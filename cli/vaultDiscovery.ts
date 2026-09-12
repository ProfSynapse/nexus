/**
 * Discover live Nexus IPC endpoints for the standalone Node CLI.
 *
 * Unix-domain sockets are regular directory entries under /tmp. Windows named
 * pipes are visible to Windows but Node's fs.readdirSync('\\\\.\\pipe\\')
 * reports ENOTDIR, so Windows enumeration uses the built-in PowerShell file
 * system provider. The command is fixed and receives no user-controlled text.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

export const NAME_PREFIX = 'nexus_mcp_';
export const UNIX_SOCK_DIR = '/tmp';
export const UNIX_SUFFIX = '.sock';
export const WIN_PIPE_DIR = '\\\\.\\pipe\\';
/** The sidecar note a running plugin writes beside its socket. */
export const NOTE_SUFFIX = '.json';

export interface VaultSocket {
    name: string;
    path: string;
}

/**
 * A live endpoint plus what its plugin published about itself. `basePath` is
 * the vault's absolute folder; absent when the plugin wrote no note (mobile,
 * an older plugin, or an unreadable note).
 */
export interface VaultEntry extends VaultSocket {
    basePath?: string;
}

/** Format live endpoints for the dynamic section in `nexus --help`. */
export function formatAvailableVaults(sockets: readonly VaultEntry[]): string {
    if (sockets.length === 0) {
        return '  (none detected — open Obsidian with Nexus enabled)';
    }

    const nameWidth = Math.max(...sockets.map((socket) => socket.name.length));
    const pathWidth = Math.max(...sockets.map((socket) => socket.path.length));
    return sockets
        .map((socket) => {
            const line = `  ${socket.name.padEnd(nameWidth)}  ${socket.path}`;
            return socket.basePath ? `${line.padEnd(nameWidth + pathWidth + 4)}  ${socket.basePath}` : line;
        })
        .join('\n');
}

/**
 * Where the plugin for this socket publishes `{ vaultName, basePath }`.
 *
 * Beside the socket on Unix (`/tmp/nexus_mcp_<vault>.json`). The Windows pipe
 * namespace holds no files, so there it lives under the temp directory. Mirrors
 * `buildVaultNotePath` in src/constants/branding.ts — MUST stay identical.
 */
export function vaultNotePath(
    socket: VaultSocket,
    platform: NodeJS.Platform = process.platform,
    tempDir: string = tmpdir()
): string {
    if (platform === 'win32') {
        return `${tempDir.replace(/[\\/]+$/, '')}\\${NAME_PREFIX}${socket.name}${NOTE_SUFFIX}`;
    }
    return socket.path.endsWith(UNIX_SUFFIX)
        ? `${socket.path.slice(0, -UNIX_SUFFIX.length)}${NOTE_SUFFIX}`
        : `${socket.path}${NOTE_SUFFIX}`;
}

/** Parse a note's text; undefined for anything that is not exactly the published shape. */
export function parseVaultNote(raw: string): { vaultName: string; basePath: string } | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { vaultName, basePath } = parsed as { vaultName?: unknown; basePath?: unknown };
    if (typeof vaultName !== 'string' || typeof basePath !== 'string' || basePath.length === 0) {
        return undefined;
    }
    return { vaultName, basePath };
}

/**
 * Attach each live socket's published folder. Only sockets already listed are
 * consulted, so a note whose plugin is gone is never seen; a missing, unreadable
 * or malformed note simply leaves `basePath` unset. The folder is resolved to
 * its real path (symlinks, on-disk casing) so it compares cleanly with a cwd
 * resolved the same way.
 */
export function readVaultNotes(
    sockets: readonly VaultSocket[],
    platform: NodeJS.Platform = process.platform,
    tempDir: string = tmpdir()
): VaultEntry[] {
    return sockets.map((socket) => {
        let raw: string;
        try {
            raw = readFileSync(vaultNotePath(socket, platform, tempDir), 'utf8');
        } catch {
            return { ...socket };
        }
        const note = parseVaultNote(raw);
        if (!note) return { ...socket };
        return { ...socket, basePath: toRealPath(note.basePath) };
    });
}

/** Canonicalise a path for comparison; falls back to the input when it cannot be resolved. */
export function toRealPath(target: string): string {
    try {
        return realpathSync.native(target);
    } catch {
        return target;
    }
}

/**
 * Pick the vault whose folder contains `cwd`, innermost first.
 *
 * Pure: reads nothing from disk. Both sides are normalised with the platform's
 * path rules, and containment is separator-aware, so `/x/Code` does not claim
 * `/x/CodeOther`. When vault folders nest, the longest (innermost) match wins,
 * because that is the vault the caller is most specifically inside. Windows
 * paths compare case-insensitively. Entries with no `basePath` never match.
 */
export function resolveVaultByCwd(
    cwd: string,
    entries: readonly VaultEntry[],
    platform: NodeJS.Platform = process.platform
): VaultEntry | undefined {
    const p = platform === 'win32' ? nodePath.win32 : nodePath.posix;
    const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
    const here = fold(p.resolve(cwd));

    let best: VaultEntry | undefined;
    let bestLength = -1;
    for (const entry of entries) {
        if (!entry.basePath) continue;
        const base = fold(p.resolve(entry.basePath));
        const prefix = base.endsWith(p.sep) ? base : `${base}${p.sep}`;
        const contains = here === base || here.startsWith(prefix);
        if (contains && base.length > bestLength) {
            best = entry;
            bestLength = base.length;
        }
    }
    return best;
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
