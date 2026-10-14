/**
 * Config file locations and read/write helpers for the MCP clients Nexus can
 * connect in one click: Claude Desktop and Antigravity (JSON `mcpServers`
 * entries) and Codex (a TOML table).
 *
 * Desktop only. Node built-ins are loaded lazily through desktopRequire, so
 * importing this module never touches them on mobile.
 */
import { Platform } from 'obsidian';
import { desktopRequire } from './desktopRequire';
import { CONNECTOR_JS_CONTENT } from './connectorContent';
import {
    readCodexMcpServerConfig,
    upsertCodexMcpServerConfig
} from './codexMcpConfig';

type FsModule = typeof import('node:fs');
type PathModule = typeof import('node:path');

/**
 * Antigravity's global MCP config, relative to the user's home folder. Change
 * it here and every reader and writer follows.
 */
export const ANTIGRAVITY_CONFIG_SEGMENTS = ['.gemini', 'config', 'mcp_config.json'] as const;

/** Where older Antigravity builds kept the same file. Read for status only, never written. */
export const ANTIGRAVITY_LEGACY_CONFIG_SEGMENTS = ['.gemini', 'antigravity', 'mcp_config.json'] as const;

export const CONNECTOR_FILE_NAME = 'connector.js';

export interface McpServerEntry {
    command: string;
    args: string[];
}

export type McpConfigState =
    | 'no-config-dir'
    | 'no-config-file'
    | 'invalid-config'
    | 'config-exists'
    | 'nexus-configured';

export interface McpConfigStatus {
    state: McpConfigState;
    /** Configured, but the saved node or connector path no longer exists (for example after an nvm switch). */
    stale: boolean;
}

export interface WriteResult {
    configPath: string;
    /** The previous file was not valid JSON; it was copied to `backupPath` and replaced. */
    replacedInvalid: boolean;
    /** Where the unreadable previous file was saved, when `replacedInvalid`. */
    backupPath?: string;
}

function fs(): FsModule {
    return desktopRequire<FsModule>('node:fs');
}

function pathMod(): PathModule {
    return desktopRequire<PathModule>('node:path');
}

export function getUserHome(): string {
    if (Platform.isWin) {
        return process.env.USERPROFILE || process.env.HOME || '';
    }
    return process.env.HOME || '';
}

export function getAntigravityConfigPath(): string {
    return pathMod().join(getUserHome(), ...ANTIGRAVITY_CONFIG_SEGMENTS);
}

export function getAntigravityLegacyConfigPath(): string {
    return pathMod().join(getUserHome(), ...ANTIGRAVITY_LEGACY_CONFIG_SEGMENTS);
}

/**
 * Claude Code keeps user-scope MCP servers in `~/.claude.json` (top-level
 * `mcpServers`). Nexus only reads that file; writes go through the `claude`
 * CLI because Claude Code rewrites the file itself while it runs.
 */
export function getClaudeCodeConfigPath(): string {
    return pathMod().join(getUserHome(), '.claude.json');
}

type ChildProcessModule = typeof import('node:child_process');

/**
 * Add or replace the Nexus server in Claude Code's user scope with
 * `claude mcp add-json --scope user`. An entry under any of the vault's keys
 * is removed first so a legacy key does not leave a second, broken server.
 */
export function writeClaudeCodeServer(claudeBin: string, serverKeys: string[], entry: McpServerEntry): WriteResult {
    const configPath = getClaudeCodeConfigPath();
    const key = serverKeys[0];
    if (!key) {
        throw new Error('No server name was given.');
    }
    const { execFileSync } = desktopRequire<ChildProcessModule>('node:child_process');
    const run = (args: string[]): void => {
        execFileSync(claudeBin, args, { encoding: 'utf-8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    };
    const existing = getMcpJsonStatus(configPath, serverKeys);
    if (existing.state === 'nexus-configured') {
        for (const candidate of serverKeys) {
            try { run(['mcp', 'remove', candidate, '--scope', 'user']); } catch { /* not registered under this key */ }
        }
    }
    run(['mcp', 'add-json', key, JSON.stringify({ type: 'stdio', command: entry.command, args: entry.args }), '--scope', 'user']);
    return { configPath, replacedInvalid: false };
}

export function getCodexConfigPath(): string {
    const path = pathMod();
    const codexHome = process.env.CODEX_HOME || path.join(getUserHome(), '.codex');
    return path.normalize(path.join(codexHome, 'config.toml'));
}

export function getConnectorPath(pluginPath: string): string {
    if (!pluginPath) {
        throw new Error('Plugin path is unavailable.');
    }
    const path = pathMod();
    return path.normalize(path.join(pluginPath, CONNECTOR_FILE_NAME));
}

/** The connector file exists and matches this build. */
export function isConnectorCurrent(pluginPath: string): boolean {
    try {
        const connectorPath = getConnectorPath(pluginPath);
        const nodeFs = fs();
        return nodeFs.existsSync(connectorPath) && nodeFs.readFileSync(connectorPath, 'utf-8') === CONNECTOR_JS_CONTENT;
    } catch {
        return false;
    }
}

/** Write connector.js into the plugin folder when it is missing or out of date. Returns its path. */
export function ensureConnectorFile(pluginPath: string): string {
    const connectorPath = getConnectorPath(pluginPath);
    const nodeFs = fs();
    const pluginDir = pathMod().dirname(connectorPath);

    if (!nodeFs.existsSync(pluginDir)) {
        nodeFs.mkdirSync(pluginDir, { recursive: true });
    }

    if (nodeFs.existsSync(connectorPath) && nodeFs.readFileSync(connectorPath, 'utf-8') === CONNECTOR_JS_CONTENT) {
        return connectorPath;
    }

    nodeFs.writeFileSync(connectorPath, CONNECTOR_JS_CONTENT, 'utf-8');
    return connectorPath;
}

/** An `mcpServers` entry. A node path is required: a bare `node` fails in apps opened from the Dock. */
export function buildMcpServerEntry(nodePath: string, connectorPath: string): McpServerEntry {
    if (!nodePath.trim()) {
        throw new Error('Node.js was not found, so the config cannot name it.');
    }
    return { command: nodePath, args: [connectorPath] };
}

/** The copyable config for any MCP client that uses `mcpServers {command, args}`. */
export function buildMcpConfigJson(serverKey: string, nodePath: string, connectorPath: string): string {
    return JSON.stringify({ mcpServers: { [serverKey]: buildMcpServerEntry(nodePath, connectorPath) } }, null, 2);
}

/** Status of a JSON `mcpServers` config (Claude Desktop, Antigravity) for any of the vault's server keys. */
export function getMcpJsonStatus(configPath: string, serverKeys: string[]): McpConfigStatus {
    const nodeFs = fs();
    const configDir = pathMod().dirname(configPath);

    if (!nodeFs.existsSync(configDir)) {
        return { state: 'no-config-dir', stale: false };
    }
    if (!nodeFs.existsSync(configPath)) {
        return { state: 'no-config-file', stale: false };
    }

    let parsed: unknown;
    try {
        const content = stripBom(nodeFs.readFileSync(configPath, 'utf-8'));
        if (!content.trim()) {
            return { state: 'invalid-config', stale: false };
        }
        parsed = JSON.parse(content) as unknown;
    } catch {
        return { state: 'invalid-config', stale: false };
    }

    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : null;
    const key = servers ? serverKeys.find(candidate => Boolean(servers[candidate])) : undefined;
    if (!servers || !key) {
        return { state: 'config-exists', stale: false };
    }

    const entry = servers[key];
    const command = isRecord(entry) && typeof entry.command === 'string' ? entry.command : '';
    const args = isRecord(entry) && Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
    return { state: 'nexus-configured', stale: hasMissingPath(command, args) };
}

/**
 * Add or update the Nexus entry in a JSON `mcpServers` config, keeping every
 * other server.
 *
 * `serverKeys` lists the vault's keys, current one first. An existing entry
 * under any of them is updated in place (only `command` and `args` change, so
 * `env` and other fields stay), which also repairs an entry left under a
 * legacy key instead of adding a second server beside it.
 */
export function writeMcpJsonServer(configPath: string, serverKeys: string[], entry: McpServerEntry): WriteResult {
    const nodeFs = fs();
    let config: Record<string, unknown> = {};
    let replacedInvalid = false;
    let backupPath: string | undefined;

    if (nodeFs.existsSync(configPath)) {
        const raw = nodeFs.readFileSync(configPath, 'utf-8');
        const content = stripBom(raw);
        if (content.trim()) {
            try {
                const parsed = JSON.parse(content) as unknown;
                if (isRecord(parsed)) {
                    config = parsed;
                } else {
                    throw new Error('not an object');
                }
            } catch {
                backupPath = uniqueBackupPath(configPath);
                nodeFs.writeFileSync(backupPath, raw, 'utf-8');
                replacedInvalid = true;
                config = {};
            }
        }
    }

    const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
    const key = serverKeys.find(candidate => isRecord(servers[candidate])) ?? serverKeys[0];
    if (!key) {
        throw new Error('No server name was given.');
    }
    const existing = isRecord(servers[key]) ? servers[key] : {};
    config.mcpServers = { ...servers, [key]: { ...existing, command: entry.command, args: entry.args } };

    const configDir = pathMod().dirname(configPath);
    if (!nodeFs.existsSync(configDir)) {
        nodeFs.mkdirSync(configDir, { recursive: true });
    }
    nodeFs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { configPath, replacedInvalid, backupPath };
}

/** Status of the Codex `config.toml` for any of the vault's server keys. */
export function getCodexStatus(serverKeys: string[]): McpConfigStatus {
    const nodeFs = fs();
    const configPath = getCodexConfigPath();
    if (!nodeFs.existsSync(configPath)) {
        return { state: 'no-config-file', stale: false };
    }

    let content: string;
    try {
        content = nodeFs.readFileSync(configPath, 'utf-8');
    } catch {
        return { state: 'invalid-config', stale: false };
    }

    for (const key of serverKeys) {
        const server = readCodexMcpServerConfig(content, key);
        if (server) {
            return { state: 'nexus-configured', stale: hasMissingPath(server.command, server.args) };
        }
    }
    return { state: 'config-exists', stale: false };
}

/**
 * Add the Nexus table to Codex's config.toml, or point an existing one (under
 * any of `serverKeys`, current one first) at the new command and args. Other
 * keys in that table, such as env and timeouts, are kept.
 */
export function writeCodexServer(serverKeys: string[], entry: McpServerEntry): WriteResult {
    const nodeFs = fs();
    const configPath = getCodexConfigPath();
    const configDir = pathMod().dirname(configPath);

    if (!nodeFs.existsSync(configDir)) {
        nodeFs.mkdirSync(configDir, { recursive: true });
    }

    const existing = nodeFs.existsSync(configPath) ? nodeFs.readFileSync(configPath, 'utf-8') : '';
    const key = serverKeys.find(candidate => readCodexMcpServerConfig(existing, candidate) !== null) ?? serverKeys[0];
    if (!key) {
        throw new Error('No server name was given.');
    }
    nodeFs.writeFileSync(configPath, upsertCodexMcpServerConfig(existing, key, entry.command, entry.args), 'utf-8');
    return { configPath, replacedInvalid: false };
}

/** An absolute command or connector path that no longer exists on disk. */
function hasMissingPath(command: string, args: string[]): boolean {
    const nodeFs = fs();
    const path = pathMod();
    return [command, args[0] ?? '']
        .filter(candidate => candidate && path.isAbsolute(candidate))
        .some(candidate => !nodeFs.existsSync(candidate));
}

/** Windows editors often save JSON with a byte order mark, which JSON.parse rejects. */
function stripBom(content: string): string {
    return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

/** `<file>.bak`, or `<file>.<n>.bak` when earlier backups exist, so none is overwritten. */
function uniqueBackupPath(configPath: string): string {
    const nodeFs = fs();
    let candidate = `${configPath}.bak`;
    for (let n = 1; nodeFs.existsSync(candidate); n++) {
        candidate = `${configPath}.${n}.bak`;
    }
    return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
