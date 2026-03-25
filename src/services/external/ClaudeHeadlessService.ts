import { App, FileSystemAdapter, Plugin, Platform } from 'obsidian';
import { getPrimaryServerKey } from '../../constants/branding';
import { resolveDesktopBinaryPath } from '../../utils/binaryDiscovery';

const MAX_SAFE_WINDOWS_ARGV_CHARS = 24_000;

export interface ClaudeHeadlessPreflightResult {
    claudePath: string | null;
    nodePath: string | null;
    connectorPath: string | null;
    vaultPath: string | null;
    isAuthenticated: boolean;
    authStatusText: string;
}

export interface ClaudeHeadlessRunOptions {
    prompt: string;
    model?: string;
    maxTurns?: number;
    bypassPermissions?: boolean;
}

export interface ClaudeHeadlessRunResult {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    commandLine: string;
    preflight: ClaudeHeadlessPreflightResult;
}

interface ProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    errorCode?: string;
}

export class ClaudeHeadlessService {
    constructor(
        private app: App,
        private plugin: Plugin
    ) {}

    async getPreflight(): Promise<ClaudeHeadlessPreflightResult> {
        const claudePath = resolveDesktopBinaryPath('claude');
        const nodePath = resolveDesktopBinaryPath('node');
        const connectorPath = this.getConnectorPath();
        const vaultPath = this.getVaultBasePath();

        if (!claudePath) {
            return {
                claudePath: null,
                nodePath,
                connectorPath,
                vaultPath,
                isAuthenticated: false,
                authStatusText: 'Claude Code was not found on PATH.'
            };
        }

        const authResult = await this.runProcess(claudePath, ['auth', 'status', '--text'], vaultPath ?? undefined, this.buildClaudeEnv());
        const authStatusText = [authResult.stdout.trim(), authResult.stderr.trim()]
            .filter(Boolean)
            .join('\n')
            .trim();

        return {
            claudePath,
            nodePath,
            connectorPath,
            vaultPath,
            isAuthenticated: authResult.exitCode === 0,
            authStatusText: authStatusText || 'Claude auth status is unavailable.'
        };
    }

    async run(options: ClaudeHeadlessRunOptions): Promise<ClaudeHeadlessRunResult> {
        const startedAt = Date.now();
        const preflight = await this.getPreflight();
        const prompt = options.prompt.trim();

        if (!Platform.isDesktop) {
            return this.buildFailureResult('Claude headless mode is only available on desktop.', preflight, startedAt);
        }

        if (!prompt) {
            return this.buildFailureResult('Prompt is required.', preflight, startedAt);
        }

        if (!preflight.claudePath) {
            return this.buildFailureResult('Claude Code was not found on PATH.', preflight, startedAt);
        }

        if (!preflight.nodePath) {
            return this.buildFailureResult('Node.js was not found on PATH.', preflight, startedAt);
        }

        if (!preflight.connectorPath) {
            return this.buildFailureResult('connector.js could not be resolved for this vault.', preflight, startedAt);
        }

        if (!preflight.vaultPath) {
            return this.buildFailureResult('Vault base path is unavailable. This experiment requires the desktop filesystem adapter.', preflight, startedAt);
        }

        const fsPromises = require('fs/promises') as typeof import('fs/promises');
        const pathMod = require('path') as typeof import('path');
        const osMod = require('os') as typeof import('os');

        const tempDir = await fsPromises.mkdtemp(pathMod.join(osMod.tmpdir(), 'nexus-claude-headless-'));
        const mcpConfigPath = pathMod.join(tempDir, 'mcp.json');

        try {
            await fsPromises.writeFile(
                mcpConfigPath,
                JSON.stringify(this.buildMcpConfig(preflight.nodePath, preflight.connectorPath), null, 2),
                'utf8'
            );

            const args = [
                '-p',
                '--strict-mcp-config',
                '--mcp-config',
                mcpConfigPath,
                '--tools',
                '',
                '--disable-slash-commands',
                '--output-format',
                'text',
                '--max-turns',
                String(Math.max(1, options.maxTurns ?? 8))
            ];

            if (options.bypassPermissions !== false) {
                args.push('--dangerously-skip-permissions');
            }

            const model = options.model?.trim();
            if (model) {
                args.push('--model', model);
            }

            this.assertSafeWindowsArgv(preflight.claudePath, args);

            const processResult = await this.runProcess(
                preflight.claudePath,
                args,
                preflight.vaultPath,
                this.buildClaudeEnv(),
                prompt
            );

            const transportError = this.mapTransportError(processResult);
            return {
                success: processResult.exitCode === 0 && !transportError,
                stdout: processResult.stdout,
                stderr: transportError || processResult.stderr,
                exitCode: processResult.exitCode,
                durationMs: Date.now() - startedAt,
                commandLine: this.formatCommand(preflight.claudePath, args),
                preflight
            };
        } catch (error) {
            return this.buildFailureResult((error as Error).message, preflight, startedAt);
        } finally {
            try {
                await fsPromises.rm(tempDir, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup only.
            }
        }
    }

    private buildMcpConfig(nodePath: string, connectorPath: string): Record<string, unknown> {
        const serverKey = getPrimaryServerKey(this.app.vault.getName());
        return {
            mcpServers: {
                [serverKey]: {
                    type: 'stdio',
                    command: nodePath,
                    args: [connectorPath]
                }
            }
        };
    }

    private buildFailureResult(message: string, preflight: ClaudeHeadlessPreflightResult, startedAt: number): ClaudeHeadlessRunResult {
        return {
            success: false,
            stdout: '',
            stderr: message,
            exitCode: null,
            durationMs: Date.now() - startedAt,
            commandLine: '',
            preflight
        };
    }

    private buildClaudeEnv(): NodeJS.ProcessEnv {
        const env = { ...process.env };

        // Favor the user's local Claude subscription login instead of any API key
        // accidentally inherited from the Obsidian/Electron environment.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;

        return env;
    }

    private async runProcess(
        command: string,
        args: string[],
        cwd?: string,
        env?: NodeJS.ProcessEnv,
        stdinText?: string
    ): Promise<ProcessResult> {
        const childProcess = require('child_process') as typeof import('child_process');

        return await new Promise<ProcessResult>((resolve) => {
            const stdio = (stdinText !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']) as any;
            const child = childProcess.spawn(command, args, {
                cwd,
                env,
                stdio
            }) as any;

            let stdout = '';
            let stderr = '';

            if (stdinText !== undefined) {
                if (!child.stdin) {
                    resolve({
                        stdout,
                        stderr: 'Failed to open Claude Code stdin for prompt input.',
                        exitCode: null
                    });
                    return;
                }

                const handleStdinError = (error: NodeJS.ErrnoException) => {
                    resolve({
                        stdout,
                        stderr: stderr ? `${stderr}\n${error.message}` : error.message,
                        exitCode: null,
                        errorCode: error.code
                    });
                };

                child.stdin.once('error', handleStdinError);
                child.stdin.end(stdinText, 'utf8', () => {
                    child.stdin?.off('error', handleStdinError);
                });
            }

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
                    exitCode: null,
                    errorCode: (error as NodeJS.ErrnoException).code
                });
            });

            child.on('close', (exitCode: number | null) => {
                resolve({
                    stdout,
                    stderr,
                    exitCode
                });
            });
        });
    }

    private getConnectorPath(): string | null {
        const vaultBasePath = this.getVaultBasePath();
        if (!vaultBasePath) {
            return null;
        }

        const pathMod = require('path') as typeof import('path');
        const manifestDir = this.plugin.manifest.dir;
        const pluginFolderName = manifestDir ? manifestDir.split('/').pop() || manifestDir : '';

        if (!pluginFolderName) {
            return null;
        }

        return pathMod.join(vaultBasePath, '.obsidian', 'plugins', pluginFolderName, 'connector.js');
    }

    private getVaultBasePath(): string | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            return adapter.getBasePath();
        }

        return null;
    }

    private formatCommand(command: string, args: string[]): string {
        const parts = [command, ...args].map((part) => {
            if (/[\s"]/u.test(part)) {
                return `"${part.replace(/"/g, '\\"')}"`;
            }
            return part;
        });

        return parts.join(' ');
    }

    private assertSafeWindowsArgv(command: string, args: string[]): void {
        if (!Platform.isWin) {
            return;
        }

        const totalChars = [command, ...args].reduce((sum, part) => sum + part.length + 1, 0);
        if (totalChars > MAX_SAFE_WINDOWS_ARGV_CHARS) {
            throw new Error('Claude headless command is too large for Windows argv transport. Shorten the prompt or attached context and try again.');
        }
    }

    private mapTransportError(result: ProcessResult): string | null {
        if (result.errorCode === 'E2BIG' || result.errorCode === 'ENAMETOOLONG') {
            return 'Claude headless command is too large for local CLI transport. Shorten the prompt or attached context and try again.';
        }

        return null;
    }
}
