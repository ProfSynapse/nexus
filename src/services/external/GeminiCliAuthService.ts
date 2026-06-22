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
     * Check authentication by reading the Antigravity/Gemini CLI credential
     * file at ~/.gemini/oauth_creds.json. This avoids launching an actual LLM
     * call (which fails when the MCP server is not running) and instead verifies
     * that valid OAuth credentials are present on disk.
     *
     * Tolerant by design: agy may write the credential file as a single JSON
     * object OR as concatenated/NDJSON records, so a strict whole-file
     * `JSON.parse` would spuriously fail. We try a whole-file parse first, then
     * fall back to scanning for a non-empty `access_token` field.
     *
     * SECURITY INVARIANT: this probe extracts PRESENCE only and returns a
     * boolean-equivalent exitCode. It MUST NEVER read, log, or return the token
     * VALUE — only whether a non-empty `access_token` exists.
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

        if (!hasNonEmptyAccessToken(raw)) {
            return {
                stdout: '',
                stderr: 'Credential file does not contain a valid access_token.',
                exitCode: 1
            };
        }

        return { stdout: 'ok', stderr: '', exitCode: 0 };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Determine, tolerantly, whether the raw credential file contents contain a
 * non-empty `access_token`. Tries (1) a whole-file JSON parse, then (2) a
 * per-line / per-record JSON parse (handles NDJSON or concatenated objects),
 * then (3) a structural regex existence check for an `access_token` key with a
 * non-empty string value.
 *
 * SECURITY: returns a boolean ONLY. The token value is inspected for
 * non-emptiness but is never captured, returned, or logged.
 */
function hasNonEmptyAccessToken(raw: string): boolean {
    // (1) Whole-file JSON object — the common single-record case.
    const whole = tryParseAccessToken(raw);
    if (whole !== null) {
        return whole;
    }

    // (2) NDJSON / concatenated records — parse each non-empty line.
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        if (tryParseAccessToken(trimmed) === true) {
            return true;
        }
    }

    // (3) Structural fallback — a JSON `access_token` key bound to a non-empty
    // string literal anywhere in the file. Matches the presence of the field
    // without extracting (or capturing) its value.
    return /"access_token"\s*:\s*"[^"]+"/.test(raw);
}

/**
 * Parse `text` as a JSON object and report whether it has a non-empty
 * `access_token` string field. Returns:
 *   true  — parsed and has a non-empty access_token
 *   false — parsed but no valid access_token
 *   null  — not parseable as a JSON object (caller should try a fallback)
 *
 * SECURITY: the token value is only length-checked; it is never returned.
 */
function tryParseAccessToken(text: string): boolean | null {
    try {
        const creds = JSON.parse(text) as unknown;
        if (!isRecord(creds)) {
            return null;
        }
        return typeof creds.access_token === 'string' && creds.access_token.length > 0;
    } catch {
        return null;
    }
}
