#!/usr/bin/env node
/**
 * nexus — local CLI bridge to a running Nexus (Obsidian) vault, no MCP client config.
 *
 * Discover:  nexus tools [selector]
 * Execute:   nexus use "<agent action --flags>" --memory "…" --goal "…"
 * Inspect:   nexus vaults | nexus doctor
 *
 * It connects to the same unix socket connector.js uses (/tmp/nexus_mcp_<vault>.sock),
 * speaks the two-tool protocol (toolManager_getTools / toolManager_useTools), prints the
 * result, and exits. Spike scope per docs/plans/local-cli-agent-bridge-plan.md §9 step 1:
 * self-contained (node builtins only), macOS/Linux sockets only.
 */
import { readdirSync } from 'node:fs';
import { McpLineClient, McpToolResult } from './mcpLineClient';

const SOCK_DIR = '/tmp';
const SOCK_PREFIX = 'nexus_mcp_';
const SOCK_SUFFIX = '.sock';

/** Mirror of connector.ts sanitizeVaultName — MUST stay identical (shared module when productionized). */
function sanitizeVaultName(name: string): string {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

interface VaultSocket { name: string; path: string; }

function listVaultSockets(): VaultSocket[] {
    try {
        return readdirSync(SOCK_DIR)
            .filter((f) => f.startsWith(SOCK_PREFIX) && f.endsWith(SOCK_SUFFIX))
            .map((f) => ({ name: f.slice(SOCK_PREFIX.length, -SOCK_SUFFIX.length), path: `${SOCK_DIR}/${f}` }));
    } catch {
        return [];
    }
}

function resolveVault(requested?: string): VaultSocket {
    const sockets = listVaultSockets();
    const want = requested ?? process.env.NEXUS_VAULT ?? undefined;
    if (want) {
        const s = sanitizeVaultName(want);
        const match = sockets.find((x) => x.name === s);
        if (!match) {
            const live = sockets.map((x) => x.name).join(', ') || '(none open)';
            throw new Error(`Vault "${want}" (→ "${s}") is not open. Live vaults: ${live}`);
        }
        return match;
    }
    if (sockets.length === 1) return sockets[0];
    if (sockets.length === 0) {
        throw new Error('No Nexus vault sockets found in /tmp. Is Obsidian open with Nexus running?');
    }
    throw new Error(`Multiple vaults open: ${sockets.map((x) => x.name).join(', ')}. Pass --vault <name>.`);
}

interface ParsedArgs { positionals: string[]; flags: Record<string, string | boolean>; }

function parseArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            } else {
                flags[key] = true;
            }
        } else {
            positionals.push(a);
        }
    }
    return { positionals, flags };
}

function printToolResult(result: McpToolResult, asJson: boolean): number {
    if (asJson) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return result.isError ? 1 : 0;
    }
    const text = (result.content ?? [])
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    const out = text || JSON.stringify(result, null, 2);
    if (result.isError) {
        process.stderr.write(out + '\n');
        return 1;
    }
    process.stdout.write(out + '\n');
    return 0;
}

const USAGE = `nexus — local CLI bridge to a running Nexus vault (no MCP config)

USAGE
  nexus tools [selector]              Discover tools (getTools). selector e.g. "storage", "storage move", "--help"
  nexus use "<command>" [context]    Execute a CLI-style tool command (useTools)
  nexus vaults                       List open Nexus vaults (live sockets)
  nexus doctor [--vault <name>]      Connect + handshake; print server info
  nexus --help                       This help

CONTEXT FLAGS (for \`use\`)
  --memory "<text>"      REQUIRED — running summary of what you're doing
  --goal "<text>"        REQUIRED — the objective of this call
  --workspace <id>       default: "default"
  --session <name>       default: "nexus-cli" (reuse one stable name per conversation)
  --constraints "<text>" optional
  --vault <name>         target a specific vault (else: single open vault, or NEXUS_VAULT)
  --json                 print raw JSON-RPC result

EXAMPLES
  nexus tools search
  nexus use "content read --path Daily/2026-07-17.md" --memory "auditing notes" --goal "read today's daily"
  nexus use "storage list" --vault "My Notes" --memory "smoke test" --goal "list vault root"
`;

async function withClient<T>(vaultName: string | undefined, fn: (c: McpLineClient) => Promise<T>): Promise<T> {
    const vault = resolveVault(vaultName);
    const client = new McpLineClient(vault.path);
    await client.connect();
    try {
        await client.initialize();
        return await fn(client);
    } finally {
        client.close();
    }
}

async function main(): Promise<number> {
    const argv = process.argv.slice(2);
    const { positionals, flags } = parseArgs(argv);
    const cmd = positionals[0];
    const asJson = flags.json === true;
    const vaultFlag = typeof flags.vault === 'string' ? flags.vault : undefined;

    if (!cmd || cmd === 'help' || flags.help === true) {
        process.stdout.write(USAGE);
        return 0;
    }

    if (cmd === 'vaults') {
        const sockets = listVaultSockets();
        if (sockets.length === 0) {
            process.stdout.write('No open Nexus vaults (no sockets in /tmp). Is Obsidian running?\n');
            return 0;
        }
        for (const s of sockets) process.stdout.write(`${s.name}\t${s.path}\n`);
        return 0;
    }

    if (cmd === 'doctor') {
        return withClient(vaultFlag, async (client) => {
            const tools = await client.listTools();
            process.stdout.write('OK — connected, handshaked, tools/list responded.\n');
            process.stdout.write(JSON.stringify(tools, null, 2) + '\n');
            return 0;
        });
    }

    if (cmd === 'tools') {
        const selector = positionals[1] ?? '--help';
        return withClient(vaultFlag, async (client) => {
            // getTools validates memory/goal too — auto-fill for discovery so callers need not pass them.
            const result = await client.callTool('toolManager_getTools', {
                tool: selector,
                workspaceId: typeof flags.workspace === 'string' ? flags.workspace : 'default',
                sessionId: typeof flags.session === 'string' ? flags.session : 'nexus-cli',
                memory: typeof flags.memory === 'string' ? flags.memory : 'Discovering available Nexus tools.',
                goal: typeof flags.goal === 'string' ? flags.goal : `Inspect "${selector}" tools.`,
            });
            return printToolResult(result, asJson);
        });
    }

    if (cmd === 'use') {
        const command = positionals[1];
        if (!command) {
            process.stderr.write('Error: `use` needs a command string, e.g. nexus use "content read --path X" --memory .. --goal ..\n');
            return 2;
        }
        const memory = typeof flags.memory === 'string' ? flags.memory : '';
        const goal = typeof flags.goal === 'string' ? flags.goal : '';
        if (!memory || !goal) {
            process.stderr.write('Error: --memory and --goal are REQUIRED (Nexus context contract).\n');
            return 2;
        }
        const args: Record<string, unknown> = {
            tool: command,
            workspaceId: typeof flags.workspace === 'string' ? flags.workspace : 'default',
            sessionId: typeof flags.session === 'string' ? flags.session : 'nexus-cli',
            memory,
            goal,
        };
        if (typeof flags.constraints === 'string') args.constraints = flags.constraints;
        return withClient(vaultFlag, async (client) => {
            const result = await client.callTool('toolManager_useTools', args);
            return printToolResult(result, asJson);
        });
    }

    process.stderr.write(`Unknown command "${cmd}". Run \`nexus --help\`.\n`);
    return 2;
}

main()
    .then((code) => process.exit(code))
    .catch((err: Error) => {
        process.stderr.write(`nexus: ${err.message}\n`);
        process.exit(1);
    });
