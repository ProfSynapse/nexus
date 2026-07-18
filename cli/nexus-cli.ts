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
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { McpLineClient, McpToolResult } from './mcpLineClient';
import { playbooksDir, parseFrontmatter, listPlaybooks } from './playbooks';

// Transport endpoints mirror connector.ts exactly:
//   macOS/Linux: unix domain socket  /tmp/nexus_mcp_<vault>.sock
//   Windows:     named pipe          \\.\pipe\nexus_mcp_<vault>
const IS_WIN = process.platform === 'win32';
const NAME_PREFIX = 'nexus_mcp_';
const UNIX_SOCK_DIR = '/tmp';
const UNIX_SUFFIX = '.sock';
const WIN_PIPE_DIR = '\\\\.\\pipe\\';

/** Mirror of connector.ts sanitizeVaultName — MUST stay identical. */
function sanitizeVaultName(name: string): string {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

/** Build the transport path for an already-sanitized vault name. */
function vaultSocketPath(sanitized: string): string {
    return IS_WIN
        ? `${WIN_PIPE_DIR}${NAME_PREFIX}${sanitized}`
        : `${UNIX_SOCK_DIR}/${NAME_PREFIX}${sanitized}${UNIX_SUFFIX}`;
}

interface VaultSocket { name: string; path: string; }

/** Enumerate live vault endpoints (unix: glob /tmp; windows: list the named-pipe namespace). */
function listVaultSockets(): VaultSocket[] {
    try {
        if (IS_WIN) {
            return readdirSync(WIN_PIPE_DIR)
                .filter((f) => f.startsWith(NAME_PREFIX))
                .map((f) => ({ name: f.slice(NAME_PREFIX.length), path: `${WIN_PIPE_DIR}${f}` }));
        }
        return readdirSync(UNIX_SOCK_DIR)
            .filter((f) => f.startsWith(NAME_PREFIX) && f.endsWith(UNIX_SUFFIX))
            .map((f) => ({ name: f.slice(NAME_PREFIX.length, -UNIX_SUFFIX.length), path: `${UNIX_SOCK_DIR}/${f}` }));
    } catch {
        return [];
    }
}

function resolveVault(requested?: string): VaultSocket {
    const want = requested ?? process.env.NEXUS_VAULT ?? undefined;
    if (want) {
        // Explicit selection: build the path directly and attempt to connect. This works
        // even where enumeration is unreliable (e.g. the Windows pipe namespace); a dead
        // endpoint surfaces a clear connect error from the client.
        const s = sanitizeVaultName(want);
        return { name: s, path: vaultSocketPath(s) };
    }
    const sockets = listVaultSockets();
    if (sockets.length === 1) return sockets[0];
    if (sockets.length === 0) {
        throw new Error('No open Nexus vaults found. Is Obsidian running with Nexus? Or pass --vault <name>.');
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
  nexus tools [selector...]           Discover tools (getTools). Drill down as far as you want:
                                        nexus tools                     all agents (catalog)
                                        nexus tools storage             one agent's tools (compact)
                                        nexus tools storage list        one tool, full arg schema
                                        nexus tools "storage list, content read"   several tools at once
  nexus use "<command>" [context]    Execute a CLI-style tool command (useTools)
  nexus playbook [name]              Task primer: list playbooks, or emit one with its
                                      workspaces + preloaded tool schemas (one call):
                                        nexus playbook                 list playbooks
                                        nexus playbook vault-work      search → read → edit
                                        nexus playbook organize        move / archive / tidy
                                        nexus playbook tasks           projects & task DAG
                                        nexus playbook prompt          run a prompt over notes
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
        // Join all positionals so unquoted drill-down works:
        //   nexus tools storage           -> "storage"        (whole agent, compact)
        //   nexus tools storage list      -> "storage list"   (one tool, full arg schema)
        //   nexus tools storage move, content read -> multiple tools, full schemas each
        const selector = positionals.slice(1).join(' ') || '--help';
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

    if (cmd === 'playbook') {
        const dir = playbooksDir();
        const name = positionals[1];

        // No name → list installed playbooks (no socket needed).
        if (!name) {
            const books = listPlaybooks(dir);
            if (books.length === 0) {
                process.stderr.write(`No playbooks installed (looked in ${dir}). Re-run the Nexus CLI installer, or set NEXUS_PLAYBOOKS_DIR.\n`);
                return 1;
            }
            process.stdout.write('Nexus playbooks — task primers. Run `nexus playbook <name>`:\n\n');
            const pad = Math.max(...books.map((b) => b.name.length));
            for (const b of books) process.stdout.write(`  ${b.name.padEnd(pad)}  ${b.intent}\n`);
            process.stdout.write('\nEach emits: the shared spine, your workspaces, the recipe, and the tools it needs (preloaded).\n');
            return 0;
        }

        // Named → compose the primer. Static parts need no socket; workspaces + tool
        // schemas do. Print the static spine first, then try the live parts.
        const file = join(dir, `${name}.md`);
        if (!existsSync(file)) {
            const books = listPlaybooks(dir);
            const names = books.map((b) => b.name).join(', ') || '(none installed)';
            process.stderr.write(`Unknown playbook "${name}". Available: ${names}. Run \`nexus playbook\` to list.\n`);
            return 2;
        }
        const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
        const preamblePath = join(dir, '_preamble.md');
        const preamble = existsSync(preamblePath) ? readFileSync(preamblePath, 'utf8').trim() : '';
        if (preamble) process.stdout.write(preamble + '\n\n');

        const ctx = {
            workspaceId: typeof flags.workspace === 'string' ? flags.workspace : 'default',
            sessionId: typeof flags.session === 'string' ? flags.session : 'nexus-cli',
            memory: `Loading the "${name}" playbook.`,
            goal: `Prepare to run the ${name} task.`,
        };
        try {
            // Fetch live parts BEFORE printing them, so a mid-stream failure falls back
            // cleanly instead of duplicating half-printed sections.
            const { workspaces, tools } = await withClient(vaultFlag, async (client) => {
                const ws = await client.callTool('toolManager_useTools', { ...ctx, tool: 'memory list-workspaces' });
                let tl: McpToolResult | null = null;
                if (meta.tools.length) {
                    tl = await client.callTool('toolManager_getTools', { ...ctx, tool: meta.tools.join(', ') });
                }
                return { workspaces: ws, tools: tl };
            });
            process.stdout.write('## Your workspaces\n\nPick one to load as step 1 (or create a new one):\n\n');
            printToolResult(workspaces, false);
            process.stdout.write('\n---\n\n' + body.trim() + '\n');
            if (tools) {
                process.stdout.write('\n## Preloaded tool schemas\n\n');
                printToolResult(tools, false);
            }
        } catch (err) {
            // No reachable vault → still give the recipe; point at the live commands.
            process.stdout.write(`## Your workspaces\n\n_(no reachable vault: ${(err as Error).message} — run \`nexus vaults\`, then load one as step 1.)_\n\n`);
            process.stdout.write('---\n\n' + body.trim() + '\n');
            if (meta.tools.length) {
                process.stdout.write(`\n## Tools for this task\n\nOnce a vault is open, preload them with:\n  nexus tools "${meta.tools.join(', ')}"\n`);
            }
        }
        return 0;
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
