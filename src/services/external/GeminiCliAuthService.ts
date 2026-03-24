/**
 * src/services/external/GeminiCliAuthService.ts
 *
 * Auth status checker for the Gemini CLI provider. The plugin does not
 * initiate authentication — users must install and authenticate the
 * Gemini CLI externally before using it. This service only checks
 * whether the CLI is present and authenticated.
 */
import { App, Platform } from 'obsidian';
import { runCliProcess, CliProcessResult } from '../../utils/cliProcessRunner';
import {
    buildGeminiCliEnv,
    buildGeminiCliSystemSettings,
    resolveGeminiCliRuntime
} from '../../utils/geminiCli';

export interface GeminiCliAuthStatus {
    available: boolean;
    loggedIn: boolean;
    authMethod: string;
    geminiPath: string | null;
    error?: string;
}

export class GeminiCliAuthService {
    constructor(private app: App) {}

    /**
     * Check whether the Gemini CLI is installed and authenticated.
     */
    async getStatus(): Promise<GeminiCliAuthStatus> {
        if (!Platform.isDesktop) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                geminiPath: null,
                error: 'Gemini CLI is only available on desktop.'
            };
        }

        const runtime = resolveGeminiCliRuntime(this.app.vault);
        if (!runtime.geminiPath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                geminiPath: null,
                error: 'Gemini CLI was not found on PATH. Install it from https://github.com/google-gemini/gemini-cli'
            };
        }

        const probe = await this.runAuthProbe();
        return {
            available: true,
            loggedIn: probe.exitCode === 0,
            authMethod: probe.exitCode === 0 ? 'google-cli-login' : 'unknown',
            geminiPath: runtime.geminiPath,
            error: probe.exitCode === 0
                ? undefined
                : 'Gemini CLI is not authenticated. Run `gemini` in your terminal and choose "Login with Google" to authenticate.'
        };
    }

    /**
     * Check if the CLI is authenticated. If yes, return the sentinel key.
     * If not, return a clear error directing the user to authenticate externally.
     *
     * This is used as the "connect" flow — it's check-only, no terminal launch.
     */
    async checkAuth(): Promise<{ success: boolean; apiKey?: string; metadata?: Record<string, string>; error?: string }> {
        const status = await this.getStatus();

        if (!status.available) {
            return { success: false, error: status.error };
        }

        if (!status.loggedIn) {
            return { success: false, error: status.error };
        }

        return {
            success: true,
            apiKey: 'gemini-cli-local-auth',
            metadata: {
                authMethod: status.authMethod,
                geminiPath: status.geminiPath || ''
            }
        };
    }

    private async runAuthProbe(): Promise<CliProcessResult> {
        const runtime = resolveGeminiCliRuntime(this.app.vault);
        if (!runtime.geminiPath || !runtime.vaultPath) {
            return { stdout: '', stderr: 'Gemini CLI runtime is unavailable.', exitCode: null };
        }

        const fsPromises = require('fs/promises') as typeof import('fs/promises');
        const osMod = require('os') as typeof import('os');
        const pathMod = require('path') as typeof import('path');
        const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-gemini-auth-'));
        const settingsPath = pathMod.join(tempDir, 'system-settings.json');

        try {
            await fsPromises.writeFile(
                settingsPath,
                JSON.stringify(buildGeminiCliSystemSettings(runtime), null, 2),
                'utf8'
            );

            const handle = runCliProcess(
                runtime.geminiPath,
                [
                    '--prompt',
                    'Reply with exactly OK.',
                    '--model',
                    'gemini-2.5-flash',
                    '--output-format',
                    'json'
                ],
                {
                    cwd: runtime.vaultPath,
                    env: buildGeminiCliEnv(settingsPath)
                }
            );
            return await handle.result;
        } finally {
            await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}
