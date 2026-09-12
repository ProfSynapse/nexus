/**
 * tests/unit/nexusCliContext.test.ts
 *
 * `nexus context` end to end minus the socket: the server builds a snapshot
 * from a REAL SessionContextManager (src/handlers/services/CliContextResource),
 * ResourceReadStrategy serves it at `nexus://context` over the standard
 * `resources/read` route, and the CLI parses and renders it (cli/context.ts).
 * The two shapes are pinned against each other here so they cannot drift.
 */
import { ResourceReadStrategy } from '../../src/handlers/strategies/ResourceReadStrategy';
import {
    NEXUS_CONTEXT_RESOURCE_URI as SERVER_URI,
    buildCliContextSnapshot,
} from '../../src/handlers/services/CliContextResource';
import type { IRequestHandlerDependencies } from '../../src/handlers/interfaces/IRequestHandlerServices';
import {
    NEXUS_CONTEXT_RESOURCE_URI as CLI_URI,
    formatContextSnapshot,
    parseContextSnapshot,
} from '../../cli/context';
import { makeManager, makeStrategy, useToolsRequest } from './helpers/sessionStickyFixtures';
import { CLI_CLIENT_NAME } from '../../src/handlers/strategies/ToolExecutionStrategy';

function makeReadStrategy(manager: ReturnType<typeof makeManager>['manager'] | undefined, vaultName?: string) {
    const readResource = jest.fn(async (uri: string) => ({ contents: [{ uri, text: '# note', mimeType: 'text/markdown' }] }));
    const deps = { resourceReadService: { readResource, readMultipleResources: jest.fn() } } as unknown as IRequestHandlerDependencies;
    const strategy = new ResourceReadStrategy(deps, {} as never, { sessionContextManager: manager, vaultName });
    return { strategy, readResource };
}

describe('nexus context', () => {
    it('the CLI and the server agree on the resource URI', () => {
        expect(CLI_URI).toBe(SERVER_URI);
        expect(CLI_URI).toBe('nexus://context');
    });

    it('a fresh vault reports no session and the default handle, without creating anything', async () => {
        const { manager, sessionService } = makeManager();

        const snapshot = await buildCliContextSnapshot(manager, 'code');

        expect(snapshot).toEqual({ vault: 'code', defaultSessionHandle: 'nexus-cli', cliSession: null });
        expect(sessionService.createSession).not.toHaveBeenCalled();
        expect(manager.getCliCurrentSession()).toBeNull();
    });

    it('after a CLI call chose a session and workspace, the snapshot names both — workspace by id AND name', async () => {
        const { manager } = makeManager();
        const { strategy } = makeStrategy(manager);
        const request = useToolsRequest({ sessionId: 'research', workspaceId: 'Research' });
        await strategy.handle({ ...request, clientName: CLI_CLIENT_NAME });

        const snapshot = await buildCliContextSnapshot(manager, 'code');

        expect(snapshot.cliSession).toEqual({
            handle: 'research',
            displaySessionId: 'research',
            workspace: { id: 'ws-research-id', name: 'Research' }
        });
    });

    it('a chosen session with no workspace yet reports workspace: null (unbound), not "default"', async () => {
        const { manager } = makeManager();
        manager.setCliCurrentSession('research');

        const snapshot = await buildCliContextSnapshot(manager, 'code');

        expect(snapshot.cliSession?.handle).toBe('research');
        expect(snapshot.cliSession?.workspace).toBeNull();
    });

    it('ResourceReadStrategy answers nexus://context itself as JSON and never consults the vault-file reader', async () => {
        const { manager } = makeManager();
        manager.setCliCurrentSession('research');
        manager.bindHandleWorkspace('research', 'ws-research-id');
        const { strategy, readResource } = makeReadStrategy(manager, 'code');

        const response = await strategy.handle({ method: 'resources/read', params: { uri: SERVER_URI } });

        expect(readResource).not.toHaveBeenCalled();
        expect(response.contents).toHaveLength(1);
        expect(response.contents[0].mimeType).toBe('application/json');
        expect(JSON.parse(response.contents[0].text)).toMatchObject({
            vault: 'code',
            cliSession: { handle: 'research', workspace: { id: 'ws-research-id', name: 'Research' } }
        });
    });

    it('other URIs still go to the vault-file reader, so the resource is additive', async () => {
        const { strategy, readResource } = makeReadStrategy(undefined);

        await strategy.handle({ method: 'resources/read', params: { uri: 'obsidian://Notes/a.md' } });

        expect(readResource).toHaveBeenCalledWith('obsidian://Notes/a.md');
    });

    it('with no manager wired (tests, early boot) the resource still answers instead of throwing', async () => {
        const { strategy } = makeReadStrategy(undefined, undefined);

        const response = await strategy.handle({ method: 'resources/read', params: { uri: SERVER_URI } });

        expect(JSON.parse(response.contents[0].text)).toEqual({ vault: null, defaultSessionHandle: 'nexus-cli', cliSession: null });
    });

    describe('CLI rendering', () => {
        it('parses exactly what the server serves', async () => {
            const { manager } = makeManager();
            manager.setCliCurrentSession('research');
            manager.bindHandleWorkspace('research', 'ws-research-id');
            const { strategy } = makeReadStrategy(manager, 'code');

            const parsed = parseContextSnapshot(await strategy.handle({ method: 'resources/read', params: { uri: CLI_URI } }));

            expect(parsed).toEqual({
                vault: 'code',
                defaultSessionHandle: 'nexus-cli',
                cliSession: { handle: 'research', displaySessionId: null, workspace: { id: 'ws-research-id', name: 'Research' } }
            });
        });

        it('renders a fresh vault as "none" with the pass-once steer', () => {
            const text = formatContextSnapshot({ vault: 'code', defaultSessionHandle: 'nexus-cli', cliSession: null });

            expect(text).toMatch(/^Vault: +code$/m);
            expect(text).toMatch(/^Session: +none/m);
            expect(text).toContain('"nexus-cli"');
            expect(text).toMatch(/^Workspace: +unbound/m);
            expect(text).toMatch(/--session <name> once/);
        });

        it('renders a remembered session with its workspace name and id, and a renamed display name', () => {
            const text = formatContextSnapshot({
                vault: 'code',
                defaultSessionHandle: 'nexus-cli',
                cliSession: { handle: 'research', displaySessionId: 'research-2', workspace: { id: 'ws-research-id', name: 'Research' } }
            });

            expect(text).toMatch(/^Session: +research +\(display name: research-2\)$/m);
            expect(text).toMatch(/^Workspace: +Research +\(ws-research-id\)$/m);
            expect(text).not.toMatch(/none|unbound/);
        });

        it('renders a remembered session whose workspace is still unbound', () => {
            const text = formatContextSnapshot({
                vault: 'code',
                defaultSessionHandle: 'nexus-cli',
                cliSession: { handle: 'research', displaySessionId: 'research', workspace: null }
            });

            expect(text).toMatch(/^Session: +research$/m);
            expect(text).toMatch(/^Workspace: +unbound/m);
        });

        it('fails loudly on a reply that is not the documented shape', () => {
            expect(() => parseContextSnapshot({ contents: [] })).toThrow(/no text content/);
            expect(() => parseContextSnapshot({ contents: [{ text: '{ nope' }] })).toThrow(/not JSON/);
            expect(() => parseContextSnapshot({ contents: [{ text: '{"vault":"code"}' }] })).toThrow(/missing fields/);
            expect(() => parseContextSnapshot({ contents: [{ text: '{"defaultSessionHandle":"x","cliSession":{"nope":1}}' }] }))
                .toThrow(/malformed cliSession/);
        });
    });
});
