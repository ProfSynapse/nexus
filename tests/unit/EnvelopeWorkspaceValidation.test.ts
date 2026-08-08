/**
 * tests/unit/EnvelopeWorkspaceValidation.test.ts — issue #317.
 *
 * The envelope guard rejected a workspace passed by NAME and then offered that
 * same workspace back as its closest match:
 *
 *   Invalid workspace "Desenvolvedor". Closest match: "Desenvolvedor". …
 *
 * Cause: acceptance and suggestion read different lists. The name was only ever
 * tested against `knownWorkspaces` — the boot-time SchemaData snapshot, which is
 * empty whenever SQLite was not query-ready at agent registration — while the id
 * was tested against the live `listWorkspaces()`. The error message was already
 * built off the live list (#311), so on exactly the vaults #311 targeted the
 * guard could only ever suggest a name it had never checked for acceptance.
 *
 * This mattered because `getTools` grounds the caller with the LIVE names and
 * instructs it to pass one of them verbatim; `useTools` then answered "do not
 * infer a workspace name from the user's wording". An agent following the
 * grounding perfectly was told it invented the name.
 */
import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';

// Reserved guides workspace — resolvable by the canonical resolver, deliberately
// absent from listWorkspaces(). See SystemGuidesWorkspaceProvider.
const SYSTEM_WORKSPACE_ID = '__system_guides__';
const SYSTEM_WORKSPACE_NAME = 'Assistant guides';

const LIVE_WORKSPACES = [
    { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor', isArchived: false },
    { id: 'b1000000-0000-0000-0000-000000000002', name: 'Dev', isArchived: false },
    { id: 'c2000000-0000-0000-0000-000000000003', name: 'Reflexao', isArchived: false },
    { id: 'd3000000-0000-0000-0000-000000000004', name: 'Retired', isArchived: true },
];

function createTool(): { tool: ITool; execute: jest.Mock } {
    const execute = jest.fn().mockResolvedValue({ success: true, projects: [] });
    const tool = {
        slug: 'listProjects',
        name: 'List Projects',
        description: '',
        version: '1.0.0',
        execute,
        getParameterSchema: jest.fn().mockReturnValue({ type: 'object', properties: {} }),
        getResultSchema: jest.fn(),
    } as unknown as ITool;
    return { tool, execute };
}

function createAgent(tool: ITool): IAgent {
    return {
        name: 'taskManager',
        description: 'Task manager',
        version: '1.0.0',
        getTools: () => [tool],
        getTool: (slug: string) => (slug === tool.slug ? tool : undefined),
        initialize: jest.fn().mockResolvedValue(undefined),
        executeTool: jest.fn(),
        setAgentManager: jest.fn(),
    };
}

/**
 * An app whose plugin resolves and whose workspaceService answers with the live
 * list — i.e. the guard's happy path, where it fails CLOSED rather than open.
 */
function createApp(): unknown {
    const plugin = {
        services: {
            workspaceService: {
                listWorkspaces: jest.fn().mockResolvedValue(LIVE_WORKSPACES),
                // Mirrors WorkspaceService.getWorkspaceByNameOrId: it short-circuits
                // on the reserved guides identifiers BEFORE any table lookup, so it
                // resolves a workspace that never appears in listWorkspaces().
                getWorkspaceByNameOrId: jest.fn(async (identifier: string) => {
                    const id = identifier.toLowerCase();
                    if (id === SYSTEM_WORKSPACE_ID || id === SYSTEM_WORKSPACE_NAME.toLowerCase()) {
                        return { id: SYSTEM_WORKSPACE_ID, name: SYSTEM_WORKSPACE_NAME };
                    }
                    return LIVE_WORKSPACES.find(w => w.id === identifier || w.name.toLowerCase() === id) ?? null;
                }),
            },
        },
    };
    return {
        plugins: { getPlugin: (id: string) => (id === 'nexus' || id === 'claudesidian-mcp' ? plugin : null) },
    };
}

/**
 * Run one envelope. `knownWorkspaces` defaults to EMPTY — the boot snapshot on a
 * vault where SQLite was not query-ready, which is the reported condition.
 */
async function runEnvelope(
    workspaceId: string,
    knownWorkspaces: Array<{ name: string; description?: string }> = []
): Promise<{ success: boolean; error?: string; executed: boolean }> {
    const { tool, execute } = createTool();
    const registry = new Map<string, IAgent>([['taskManager', createAgent(tool)]]);
    const service = new ToolBatchExecutionService(
        createApp() as never,
        registry,
        knownWorkspaces as never
    );

    const result = await service.execute({
        context: {
            workspaceId,
            sessionId: 'nexus-cli',
            memory: 'Listing projects for the active workspace.',
            goal: 'List active projects.',
        },
        calls: [{ agent: 'taskManager', tool: 'listProjects', params: { status: 'active' } }],
    } as never);

    return {
        success: result.success !== false,
        error: (result as { error?: string }).error,
        executed: execute.mock.calls.length > 0,
    };
}

describe('envelope workspace validation (issue #317)', () => {
    it('accepts a workspace passed by NAME when the boot snapshot is empty', async () => {
        // The reported failure: getTools hands back "Desenvolvedor" from the live
        // list, the caller passes it verbatim, and the guard rejects it.
        const result = await runEnvelope('Desenvolvedor');

        expect(result.error).toBeUndefined();
        expect(result.executed).toBe(true);
    });

    it('accepts the same workspace by UUID (this path already worked)', async () => {
        // Pins the defect to the by-name path rather than to the guard as a whole.
        const result = await runEnvelope('a8fbad11-7412-49c8-bce0-5690e2c1d197');

        expect(result.error).toBeUndefined();
        expect(result.executed).toBe(true);
    });

    it('accepts a name case-insensitively, matching the snapshot path', async () => {
        const result = await runEnvelope('desenvolvedor');

        expect(result.error).toBeUndefined();
        expect(result.executed).toBe(true);
    });

    it('accepts an archived workspace by name, as the id path already does', async () => {
        // Acceptance is symmetric: the id branch matches the full list, so the
        // name branch must too, or the two forms disagree for archived rows.
        expect((await runEnvelope('d3000000-0000-0000-0000-000000000004')).error).toBeUndefined();
        expect((await runEnvelope('Retired')).error).toBeUndefined();
    });

    it('still rejects an identifier that resolves to nothing', async () => {
        // The guard must keep working — this is not a "accept everything" fix.
        const result = await runEnvelope('--workspaceId');

        expect(result.executed).toBe(false);
        expect(result.error).toMatch(/Invalid workspace "--workspaceId"/);
        expect(result.error).toMatch(/Available: "default" \(global\), "Desenvolvedor", "Dev", "Reflexao"/);
        // Archived workspaces stay out of the suggestion list.
        expect(result.error).not.toMatch(/Retired/);
    });

    it('accepts "default" without consulting any list', async () => {
        expect((await runEnvelope('default')).error).toBeUndefined();
    });

    /**
     * Self-contradiction lock. Rather than another hand-picked case, this asserts
     * the invariant the bug violated: the guard may never reject a value while
     * naming that same value as the closest match. Any future divergence between
     * the list it accepts from and the list it suggests from fails here,
     * whichever direction it drifts.
     */
    it('never rejects a value while offering that same value as the closest match', async () => {
        for (const workspace of LIVE_WORKSPACES) {
            for (const identifier of [workspace.name, workspace.id]) {
                const { error } = await runEnvelope(identifier);
                if (error) {
                    expect(`${identifier}: ${error}`).not.toContain(`Closest match: "${identifier}"`);
                }
            }
        }
    });

    /**
     * Issue #319. The guard reads `listWorkspaces()`, which omits the reserved
     * guides workspace BY DESIGN — `WorkspaceService.getWorkspaceByNameOrId`
     * short-circuits to it before any table lookup, and a repo test pins that it
     * never appears in listings. So the one workspace the product deliberately
     * hides is the one the gate cannot accept, by either identifier. Same shape
     * as #317: the accepting source and the authoritative source differ.
     */
    describe('reserved guides workspace (issue #319)', () => {
        it('accepts the guides workspace by its reserved id', async () => {
            expect((await runEnvelope('__system_guides__')).error).toBeUndefined();
        });

        it('accepts the guides workspace by its display name', async () => {
            expect((await runEnvelope('Assistant guides')).error).toBeUndefined();
        });

        it('accepts the guides workspace name case-insensitively', async () => {
            expect((await runEnvelope('assistant guides')).error).toBeUndefined();
        });

        it('never advertises the hidden workspace in a rejection message', async () => {
            // Accepting it must not leak it into the alternatives — the suggestion
            // path stays on listWorkspaces() precisely because it is hidden.
            const { error } = await runEnvelope('totally-unknown-workspace');

            expect(error).toMatch(/Invalid workspace/);
            expect(error).not.toMatch(/Assistant guides/);
            expect(error).not.toMatch(/__system_guides__/);
        });
    });
});
