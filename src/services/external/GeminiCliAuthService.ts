/**
 * src/services/external/GeminiCliAuthService.ts
 *
 * Auth status checker for the Gemini CLI provider. The plugin does not
 * initiate authentication — users must install and authenticate the
 * Gemini CLI externally before using it. This service only checks
 * whether the CLI is present and authenticated.
 */
import { App, Platform } from 'obsidian';
import { CliProcessResult } from '../../utils/cliProcessRunner';
import { desktopRequire } from '../../utils/desktopRequire';
import { resolveGeminiCliRuntime } from '../../utils/geminiCli';

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

        const runtime = await Promise.resolve(resolveGeminiCliRuntime(this.app.vault));
        if (!runtime.geminiPath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                geminiPath: null,
                error: 'Gemini CLI was not found on PATH. Install it from https://github.com/google-gemini/gemini-cli'
            };
        }

        const probe = await Promise.resolve(this.runAuthProbe());
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

    /**
     * Check authentication by reading the Gemini CLI credential file at
     * ~/.gemini/oauth_creds.json. This avoids launching an actual LLM call
     * (which fails when the MCP server is not running) and instead verifies
     * that valid OAuth credentials are present on disk.
     *
     * Returns exitCode 0 if credentials exist and contain an access token,
     * non-zero otherwise.
     */
    private runAuthProbe(): CliProcessResult {
        const fs = desktopRequire<typeof import('node:fs')>('node:fs');
        const osMod = desktopRequire<typeof import('node:os')>('node:os');
        const pathMod = desktopRequire<typeof import('node:path')>('node:path');

        const credsPath = pathMod.join(osMod.homedir(), '.gemini', 'oauth_creds.json');

        // Check file exists and is accessible
        try {
            fs.accessSync(credsPath, fs.constants.R_OK);
        } catch {
            return {
                stdout: '',
                stderr: `Credential file not found or not readable: ${credsPath}`,
                exitCode: 1
            };
        }

        // Read and validate the credential file
        let raw: string;
        try {
            raw = fs.readFileSync(credsPath, 'utf8');
        } catch (err) {
            return {
                stdout: '',
                stderr: `Failed to read credential file: ${(err as Error).message}`,
                exitCode: 1
            };
        }

        if (!raw || raw.trim().length === 0) {
            return {
                stdout: '',
                stderr: 'Credential file is empty.',
                exitCode: 1
            };
        }

        // Parse and confirm an access token is present
        try {
            const creds = JSON.parse(raw) as unknown;
            const hasToken = isRecord(creds) && typeof creds.access_token === 'string' && creds.access_token.length > 0;
            if (!hasToken) {
                return {
                    stdout: '',
                    stderr: 'Credential file does not contain a valid access_token.',
                    exitCode: 1
                };
            }
        } catch {
            return {
                stdout: '',
                stderr: 'Credential file is not valid JSON.',
                exitCode: 1
            };
        }

        return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
