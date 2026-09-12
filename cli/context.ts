/**
 * `nexus context` — parse and render what the vault remembers for the CLI.
 * Pure, unit-testable; the socket work lives in nexus-cli.ts.
 *
 * The server answers a `resources/read` of `nexus://context` with a JSON
 * snapshot (src/handlers/services/CliContextResource.ts). This module is the
 * CLI-side mirror of that shape: keep the two in step.
 */

export const NEXUS_CONTEXT_RESOURCE_URI = 'nexus://context';

export interface ContextSnapshot {
    vault: string | null;
    defaultSessionHandle: string;
    cliSession: {
        handle: string;
        displaySessionId: string | null;
        workspace: { id: string; name?: string } | null;
    } | null;
}

interface ResourceReadResultLike {
    contents?: Array<{ uri?: string; text?: string; mimeType?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pull the snapshot out of a `resources/read` result. Throws on anything but
 * the documented shape — a wrong server version must fail loudly rather
 * than print "none" for a session that is in fact remembered.
 */
export function parseContextSnapshot(result: unknown): ContextSnapshot {
    const contents = (result as ResourceReadResultLike | null)?.contents;
    const entry = Array.isArray(contents) ? contents.find((c) => typeof c?.text === 'string') : undefined;
    if (!entry || typeof entry.text !== 'string') {
        throw new Error(`Unexpected reply to ${NEXUS_CONTEXT_RESOURCE_URI}: no text content. Is the Nexus plugin up to date?`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(entry.text) as unknown;
    } catch {
        throw new Error(`Unexpected reply to ${NEXUS_CONTEXT_RESOURCE_URI}: not JSON.`);
    }
    if (!isRecord(parsed) || typeof parsed.defaultSessionHandle !== 'string' || !('cliSession' in parsed)) {
        throw new Error(`Unexpected reply to ${NEXUS_CONTEXT_RESOURCE_URI}: missing fields.`);
    }
    const session = parsed.cliSession;
    if (session !== null && (!isRecord(session) || typeof session.handle !== 'string')) {
        throw new Error(`Unexpected reply to ${NEXUS_CONTEXT_RESOURCE_URI}: malformed cliSession.`);
    }
    const workspace = isRecord(session) ? session.workspace : null;
    return {
        vault: typeof parsed.vault === 'string' ? parsed.vault : null,
        defaultSessionHandle: parsed.defaultSessionHandle,
        cliSession: isRecord(session)
            ? {
                handle: session.handle as string,
                displaySessionId: typeof session.displaySessionId === 'string' ? session.displaySessionId : null,
                workspace: isRecord(workspace) && typeof workspace.id === 'string'
                    ? { id: workspace.id, ...(typeof workspace.name === 'string' ? { name: workspace.name } : {}) }
                    : null,
            }
            : null,
    };
}

/** Human-readable rendering; `--json` prints the snapshot itself instead. */
export function formatContextSnapshot(snapshot: ContextSnapshot): string {
    const lines: string[] = [];
    lines.push(`Vault:      ${snapshot.vault ?? '(unknown)'}`);

    const session = snapshot.cliSession;
    if (!session) {
        lines.push(`Session:    none — the next CLI call runs as "${snapshot.defaultSessionHandle}".`);
        lines.push('            Pass --session <name> once to choose one; later calls continue it.');
        lines.push('Workspace:  unbound — pass --workspace <name> once, or run `memory load-workspace <name>`.');
        return lines.join('\n') + '\n';
    }

    const renamed = session.displaySessionId && session.displaySessionId !== session.handle
        ? `  (display name: ${session.displaySessionId})`
        : '';
    lines.push(`Session:    ${session.handle}${renamed}`);

    if (session.workspace) {
        const { id, name } = session.workspace;
        lines.push(`Workspace:  ${name && name !== id ? `${name}  (${id})` : id}`);
    } else {
        lines.push('Workspace:  unbound — pass --workspace <name> once, or run `memory load-workspace <name>`.');
    }
    lines.push('');
    lines.push('Calls without --session/--workspace use these. Pass a different value once to switch.');
    return lines.join('\n') + '\n';
}
