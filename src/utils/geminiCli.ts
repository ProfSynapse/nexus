import { Vault } from 'obsidian';
import { getPrimaryServerKey } from '../constants/branding';
import { resolveDesktopBinaryPath } from './binaryDiscovery';
import { getVaultBasePath, getConnectorPath } from './cliPathUtils';

export interface GeminiCliRuntime {
    geminiPath: string | null;
    nodePath: string | null;
    connectorPath: string | null;
    vaultPath: string | null;
    serverKey: string;
}

const BUILT_IN_TOOL_EXCLUSIONS = [
    'edit',
    'list_directory',
    'read_file',
    'read_many_files',
    'run_shell_command',
    'save_memory',
    'web_fetch',
    'write_file',
    'google_web_search'
];

export function resolveGeminiCliRuntime(vault: Vault): GeminiCliRuntime {
    const geminiPath = resolveDesktopBinaryPath('gemini');
    const nodePath = resolveDesktopBinaryPath('node');
    const vaultPath = getVaultBasePath(vault);

    return {
        geminiPath,
        nodePath,
        connectorPath: getConnectorPath(vaultPath),
        vaultPath,
        serverKey: getPrimaryServerKey(vault.getName())
    };
}

export function buildGeminiCliEnv(systemSettingsPath?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };

    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    delete env.GOOGLE_GENAI_USE_VERTEXAI;
    delete env.GOOGLE_CLOUD_PROJECT;
    delete env.GOOGLE_APPLICATION_CREDENTIALS;

    if (systemSettingsPath) {
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = systemSettingsPath;
    } else {
        delete env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    }

    return env;
}

export function buildGeminiCliSystemSettings(runtime: GeminiCliRuntime): Record<string, unknown> {
    return {
        general: {
            disableAutoUpdate: true,
            disableUpdateNag: true
        },
        privacy: {
            usageStatisticsEnabled: false
        },
        security: {
            folderTrust: {
                enabled: false
            }
        },
        ui: {
            hideBanner: true,
            hideFooter: true,
            hideTips: true
        },
        output: {
            format: 'json'
        },
        tools: {
            sandbox: false,
            core: [],
            exclude: BUILT_IN_TOOL_EXCLUSIONS
        },
        mcp: {
            allowed: [runtime.serverKey]
        },
        mcpServers: runtime.nodePath && runtime.connectorPath ? {
            [runtime.serverKey]: {
                command: runtime.nodePath,
                args: [runtime.connectorPath],
                cwd: runtime.vaultPath || undefined,
                timeout: 600000,
                trust: true,
                includeTools: ['getTools', 'useTools']
            }
        } : {}
    };
}

