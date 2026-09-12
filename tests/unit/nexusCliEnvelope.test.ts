/**
 * tests/unit/nexusCliEnvelope.test.ts
 *
 * The CLI sends `workspaceId` / `sessionId` ONLY when the flag was given
 * (#214, session-sticky-context-plan.md PR 2). It used to fill
 * `workspaceId: 'default'` and `sessionId: 'nexus-cli'` client-side; the
 * server owns both defaults now, and a client-side `'default'` is exactly
 * the silent misfiling the plan removes. Pure builders, no socket.
 */
import {
    buildPlaybookEnvelope,
    buildToolsEnvelope,
    buildUseEnvelope,
    contextFromFlags,
} from '../../cli/envelope';

describe('CLI envelope carries no client-side defaults', () => {
    it('contextFromFlags emits a key only for a flag that was given', () => {
        expect(contextFromFlags({})).toEqual({});
        expect(contextFromFlags({ memory: 'm', goal: 'g', json: true })).toEqual({});
        expect(contextFromFlags({ workspace: 'Research' })).toEqual({ workspaceId: 'Research' });
        expect(contextFromFlags({ session: 'research' })).toEqual({ sessionId: 'research' });
        expect(contextFromFlags({ workspace: 'Research', session: 'research' }))
            .toEqual({ workspaceId: 'Research', sessionId: 'research' });
    });

    it('a boolean flag value (flag given with no value) is not a workspace or session', () => {
        // parseOuterArgs rejects this shape before it gets here, but the
        // builder must not turn `true` into a string either way.
        expect(contextFromFlags({ workspace: true, session: true })).toEqual({});
    });

    it('`use` sends only tool, memory and goal when no context flags were given — no "default", no "nexus-cli"', () => {
        const args = buildUseEnvelope({ memory: 'm', goal: 'g' }, 'storage list', 'm', 'g');

        expect(args).toEqual({ tool: 'storage list', memory: 'm', goal: 'g' });
        expect(args).not.toHaveProperty('workspaceId');
        expect(args).not.toHaveProperty('sessionId');
        expect(JSON.stringify(args)).not.toMatch(/default|nexus-cli/);
    });

    it('`use` forwards the flags that were given, unchanged', () => {
        const args = buildUseEnvelope(
            { workspace: 'Research', session: 'research', constraints: 'read only', 'operation-id': 'op-1' },
            'storage list', 'm', 'g'
        );

        expect(args).toEqual({
            tool: 'storage list',
            workspaceId: 'Research',
            sessionId: 'research',
            memory: 'm',
            goal: 'g',
            constraints: 'read only',
            operationId: 'op-1',
        });
    });

    it('`tools` auto-fills memory/goal for discovery but never the workspace or session', () => {
        const args = buildToolsEnvelope({}, 'storage list');

        expect(args.tool).toBe('storage list');
        expect(typeof args.memory).toBe('string');
        expect(args.goal).toContain('storage list');
        expect(args).not.toHaveProperty('workspaceId');
        expect(args).not.toHaveProperty('sessionId');

        expect(buildToolsEnvelope({ session: 'research', memory: 'mine', goal: 'also mine' }, '--help'))
            .toEqual({ tool: '--help', sessionId: 'research', memory: 'mine', goal: 'also mine' });
    });

    it('`playbook` fills memory/goal and forwards only the context flags given', () => {
        expect(buildPlaybookEnvelope({}, 'vault-work')).toEqual({
            memory: 'Loading the "vault-work" playbook.',
            goal: 'Prepare to run the vault-work task.',
        });
        expect(buildPlaybookEnvelope({ workspace: 'Research' }, 'tasks')).toMatchObject({ workspaceId: 'Research' });
        expect(buildPlaybookEnvelope({ workspace: 'Research' }, 'tasks')).not.toHaveProperty('sessionId');
    });
});
