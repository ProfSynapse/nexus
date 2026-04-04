/* eslint-disable import/no-nodejs-modules -- desktop-only Claude Code auth uses Node child_process in Electron */
import { App, FileSystemAdapter, Platform } from 'obsidian';
import { resolveDesktopBinaryPath } from '../../utils/binaryDiscovery';

export interface ClaudeCodeAuthStatus {
    available: boolean;
    loggedIn: boolean;
    authMethod: string;
    claudePath: string | null;
    error?: string;
}

interface ClaudeAuthStatusJson {
    loggedIn?: boolean;
    authMethod?: string;
}

export class ClaudeCodeAuthService {
    constructor(private app: App) {}

    async getStatus(): Promise<ClaudeCodeAuthStatus> {
        const claudePath = resolveDesktopBinaryPath('claude');
        if (!claudePath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                claudePath: null,
                error: 'Claude Code was not found on PATH.'
            };
        }

        const result = await this.runProcess(claudePath, ['auth', 'status'], this.getVaultBasePath() ?? undefined);
        const raw = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n').trim();

        try {
            const parsed = JSON.parse(result.stdout) as ClaudeAuthStatusJson;
            return {
                available: true,
                loggedIn: !!parsed.loggedIn,
                authMethod: parsed.authMethod || 'unknown',
                claudePath
            };
        } catch {
            return {
                available: true,
                loggedIn: false,
                authMethod: 'unknown',
                claudePath,
                error: raw || 'Unable to read Claude auth status.'
            };
        }
    }

    async connectSubscriptionLogin(): Promise<{ success: boolean; apiKey?: string; metadata?: Record<string, string>; error?: string }> {
        if (!Platform.isDesktop) {
            return { success: false, error: 'Claude Code auth is only available on desktop.' };
        }

        const initialStatus = await this.getStatus();
        if (!initialStatus.available || !initialStatus.claudePath) {
            return { success: false, error: initialStatus.error || 'Claude Code was not found on PATH.' };
        }

        if (initialStatus.loggedIn) {
            return {
                success: true,
                apiKey: 'claude-code-local-auth',
                metadata: {
                    authMethod: initialStatus.authMethod,
                    claudePath: initialStatus.claudePath
                }
            };
        }

        const childProcess = await import('node:child_process');
        const child = childProcess.spawn(
            initialStatus.claudePath,
            ['auth', 'login', '--claudeai'],
            {
                cwd: this.getVaultBasePath() ?? undefined,
                env: { ...process.env },
                stdio: 'ignore'
            }
        );

        const startedAt = Date.now();
        const timeoutMs = 180_000;
        while (Date.now() - startedAt < timeoutMs) {
            await this.sleep(1500);

            const status = await this.getStatus();
            if (status.loggedIn) {
                return {
                    success: true,
                    apiKey: 'claude-code-local-auth',
                    metadata: {
                        authMethod: status.authMethod,
                        claudePath: status.claudePath || initialStatus.claudePath
                    }
                };
            }

            if (child.exitCode !== null && child.exitCode !== 0) {
                return {
                    success: false,
                    error: 'Claude login exited before authentication completed.'
                };
            }
        }

        return {
            success: false,
            error: 'Claude login did not complete in time. If needed, run `claude auth login --claudeai` in your terminal and try again.'
        };
    }

    private async runProcess(
        command: string,
        args: string[],
        cwd?: string
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
        const childProcess = await import('node:child_process');

        return await new Promise((resolve) => {
            const child = childProcess.spawn(command, args, {
                cwd,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk: Buffer | string) => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', (chunk: Buffer | string) => {
                stderr += chunk.toString();
            });

            child.on('error', (error: Error) => {
                resolve({
                    stdout,
                    stderr: stderr ? `${stderr}\n${error.message}` : error.message,
                    exitCode: null
                });
            });

            child.on('close', (exitCode: number | null) => {
                resolve({ stdout, stderr, exitCode });
            });
        });
    }

    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            return adapter.getBasePath();
        }

        return null;
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise((resolve) => window.setTimeout(resolve, ms));
    }
}
