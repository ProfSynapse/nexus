#!/usr/bin/env node
/**
 * nexus — local CLI bridge to a running Nexus (Obsidian) vault, no MCP client config.
 *
 * Discover:  nexus tools [selector]
 * Execute:   nexus use --memory "…" --goal "…" -- <agent action --flags>
 * Inspect:   nexus vaults | nexus doctor
 *
 * It connects to the same unix socket connector.js uses (/tmp/nexus_mcp_<vault>.sock),
 * speaks the two-tool protocol (toolManager_getTools / toolManager_useTools), prints the
 * result, and exits. Spike scope per docs/plans/local-cli-agent-bridge-plan.md §9 step 1:
 * self-contained (node builtins only), macOS/Linux sockets only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpLineClient, McpToolResult } from './mcpLineClient';
import { playbooksDir, parseFrontmatter, listPlaybooks } from './playbooks';
import { partitionUseArgv, resolveUseCommand } from './commandLine';
import {
    listVaultSockets,
    NAME_PREFIX,
    UNIX_SOCK_DIR,
    UNIX_SUFFIX,
    WIN_PIPE_DIR,
    VaultSocket,
    isOwnUnixSocket,
} from './vaultDiscovery';

// Transport endpoints mirror connector.ts exactly:
//   macOS/Linux: unix domain socket  /tmp/nexus_mcp_<vault>.sock
//   Windows:     named pipe          \\.\pipe\nexus_mcp_<vault>
const IS_WIN = process.platform === 'win32';
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

function resolveVault(requested?: string): VaultSocket {
    const want = requested ?? process.env.NEXUS_VAULT ?? undefined;
    if (want) {
        // Explicit selection: build the path directly and attempt to connect. This works
        // even where enumeration is unreliable (e.g. the Windows pipe namespace); a dead
        // endpoint surfaces a clear connect error from the client.
        const s = sanitizeVaultName(want);
        const p = vaultSocketPath(s);
        if (!IS_WIN && existsSync(p) && !isOwnUnixSocket(p)) {
            throw new Error(`Refusing to connect: ${p} is not owned by the current user.`);
        }
        return { name: s, path: p };
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

// `nexus --help` is the AUTHORITATIVE, always-current operating manual: it ships
// with the binary, works offline (no socket), and is regenerated on every rebuild —
// so SKILL.md can stay thin and defer here instead of duplicating volatile reference.
// The live per-vault tool catalog lives in `nexus tools`; task recipes in `nexus playbook`.
function buildUsage(): string {
    // Playbook list is generated from what's installed, so it never goes stale.
    let playbookLines: string;
    try {
        const books = listPlaybooks(playbooksDir());
        playbookLines = books.length
            ? books.map((b) => `    ${b.name.padEnd(11)}${b.intent}`).join('\n')
            : '    (none installed — re-run the Nexus CLI installer)';
    } catch {
        playbookLines = '    (run `nexus playbook` to list)';
    }

    return `nexus — drive a running Nexus (Obsidian) vault from the shell (no MCP config)

Two verbs: DISCOVER what you can do, then EXECUTE. Discovery returns schemas, never
vault content — don't loop it hunting for data. Search/list return LOCATIONS; read
before you act. You cannot escape the vault (no ../~/absolute paths).

COMMANDS
  nexus tools [selector...]          DISCOVER — tool schemas (getTools). Drill down:
                                       nexus tools                   all agents (catalog)
                                       nexus tools storage           one agent's tools
                                       nexus tools storage list      one tool, full arg schema
                                       nexus tools "storage list, content read"   several
  nexus use [context] -- <command>    EXECUTE a tool (useTools). See CONTEXT below.
  nexus playbook [name]              Task primer: recipe + your workspaces + preloaded
                                     tools, in one call. \`nexus playbook\` lists them.
  nexus vaults                       List open Nexus vaults (live sockets)
  nexus doctor [--vault <name>]      Connect + handshake; print server info
  nexus --help                       This manual

CONTEXT (flags on \`use\`; \`tools\` accepts them too. \`playbook\` reads only
         --workspace/--session/--vault and fills memory/goal for you)
  --memory "<text>"       REQUIRED — rolling summary of what you've done/learned
  --goal "<text>"         REQUIRED — this call's objective, one sentence
                          (empty or placeholder like "N/A" is REJECTED with a steer)
  --workspace <id>        scope for traces/memory (default: "default")
  --session <name>        continuity across calls (default: "nexus-cli"; keep it stable)
  --constraints "<text>"  optional guardrails
  --vault <name>          target a vault (else: the single open one, or $NEXUS_VAULT)
  --json                  print the raw JSON result
  --dry-run               print the reconstructed request; do not connect or execute

CLI SYNTAX
  • Canonical form: context flags first, then \`--\`, then one tool command as normal
    shell arguments. Commands are kebab-case (content set-property, memory load-workspace).
    Multiword values need only one shell quote layer: --workspace "NeuroAI Mapping".
  • The legacy one-string form remains supported. On Windows PowerShell, nested double
    quotes can be consumed before Node receives them; prefer the canonical \`--\` form.
  • Paths are vault-relative. "..", "~", absolute paths are rejected; a leading "/" is
    stripped. You cannot read or write outside the vault.
  • Arrays: --tags "[work, urgent]". Wikilinks keep brackets: --links "[[[A]], [[B]]]".
  • content replace is pattern-anchored {path, start, end, content} — start/end are
    exact ANCHOR TEXT from the note, not line numbers. Read the note first. (insert
    handles append/prepend.)

GOTCHAS
  • \`nexus tools\` returns schemas, not data — never loop it for content.
  • Search/list return locations (path + score) — follow every hit with \`content read\`.
  • \`content read\` requires a start line: content read --path X --start-line 1 (1 = top).
  • ALL flags are kebab-case — camelCase (e.g. --newPath, --activeTask) is rejected as
    an unknown flag; use --new-path, --active-task. Get exact flags from \`nexus tools <tool>\`.
  • Context fields (--workspace/--session/--memory/--goal) go before \`--\`, never
    after it — e.g. --workspace-id inside the tool command is rejected.
  • --memory/--goal are enforced — send real values or the call is rejected.
  • Media generation is async — \`prompt generate-*\` returns a job; poll
    \`prompt check-generated-artifact\`.
  • States: the AI gets archive (reversible), not delete.
  • No open vault → the socket is absent; open Obsidian with Nexus. Multiple open →
    pass --vault <name>.

TOOL CATALOG
  Core agents (always on): content, storage, search, canvas, task, memory, prompt, ingest.
  Apps (opt-in, per vault): composer, data, elevenlabs, skills, web — appear only when
  enabled. The live, authoritative catalog for THIS vault is always: nexus tools

PLAYBOOKS  (nexus playbook <name>)
${playbookLines}

EXAMPLES
  nexus tools "content read, search content"
  nexus use --memory "auditing notes" --goal "read today's daily" -- content read --path Daily/2026-07-17.md --start-line 1
  nexus use --vault "My Notes" --memory "smoke test" --goal "list vault root" -- storage list
  nexus use --dry-run --memory "resuming research" --goal "load workspace" -- memory load-workspace --workspace "NeuroAI Mapping" --limit 1
  nexus playbook vault-work
`;
}

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
    const { outerArgv, toolArgv } = partitionUseArgv(argv);
    const { positionals, flags } = parseArgs(outerArgv);
    const cmd = positionals[0];
    const asJson = flags.json === true;
    const vaultFlag = typeof flags.vault === 'string' ? flags.vault : undefined;

    if (!cmd || cmd === 'help' || flags.help === true) {
        process.stdout.write(buildUsage());
        return 0;
    }

    if (cmd === 'vaults') {
        const sockets = listVaultSockets();
        if (sockets.length === 0) {
            process.stdout.write('No open Nexus vaults. Is Obsidian running with Nexus enabled?\n');
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
        // Guard the name: it becomes a filename, so reject path separators / traversal
        // before the join (validate-in-code, matching the vault-path confinement rule).
        if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
            process.stderr.write(`Invalid playbook name "${name}". Use a plain name — run \`nexus playbook\` to list.\n`);
            return 2;
        }
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
        let command: string;
        try {
            command = resolveUseCommand(positionals, toolArgv);
        } catch (error) {
            process.stderr.write(`Error: ${(error as Error).message}\n`);
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
        if (flags['dry-run'] === true) {
            process.stdout.write('DRY RUN — no vault connection and no tool execution.\n');
            process.stdout.write(JSON.stringify(args, null, 2) + '\n');
            return 0;
        }
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
