/**
 * Envelope builders for the nexus CLI — pure, side-effect-free, unit-testable.
 *
 * One rule (#214, docs/plans/session-sticky-context-plan.md PR 2): the CLI
 * sends `workspaceId` / `sessionId` ONLY when the caller passed the flag. It
 * used to fill `workspaceId: 'default'` and `sessionId: 'nexus-cli'` when
 * they were absent, which put a second source of defaults outside the vault
 * and — the `'default'` half — filed unbound sessions under the global
 * workspace silently. The server owns both defaults now: the workspace is
 * inherited from the session's bind (or the call fails with the "pass it
 * once" steer), and the session is the vault's remembered CLI session, else
 * `nexus-cli`.
 */

export type ParsedFlags = Record<string, string | boolean>;

export interface ContextEnvelope {
    workspaceId?: string;
    sessionId?: string;
}

/** Only keys whose flag was actually given, so an absent flag is an absent key. */
export function contextFromFlags(flags: ParsedFlags): ContextEnvelope {
    const envelope: ContextEnvelope = {};
    if (typeof flags.workspace === 'string') envelope.workspaceId = flags.workspace;
    if (typeof flags.session === 'string') envelope.sessionId = flags.session;
    return envelope;
}

/** `nexus tools [selector]` — getTools validates memory/goal too, so discovery auto-fills them. */
export function buildToolsEnvelope(flags: ParsedFlags, selector: string): Record<string, unknown> {
    return {
        tool: selector,
        ...contextFromFlags(flags),
        memory: typeof flags.memory === 'string' ? flags.memory : 'Discovering available Nexus tools.',
        goal: typeof flags.goal === 'string' ? flags.goal : `Inspect "${selector}" tools.`,
    };
}

/** `nexus playbook <name>` — the context shared by its list-workspaces and getTools calls. */
export function buildPlaybookEnvelope(flags: ParsedFlags, name: string): Record<string, unknown> {
    return {
        ...contextFromFlags(flags),
        memory: `Loading the "${name}" playbook.`,
        goal: `Prepare to run the ${name} task.`,
    };
}

/**
 * `nexus use ... -- <command>` — memory and goal are the caller's; the caller
 * has already rejected the command when either is missing.
 */
export function buildUseEnvelope(flags: ParsedFlags, command: string, memory: string, goal: string): Record<string, unknown> {
    const args: Record<string, unknown> = {
        tool: command,
        ...contextFromFlags(flags),
        memory,
        goal,
    };
    if (typeof flags.constraints === 'string') args.constraints = flags.constraints;
    if (typeof flags['operation-id'] === 'string') args.operationId = flags['operation-id'];
    return args;
}
