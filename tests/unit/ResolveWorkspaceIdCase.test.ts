/**
 * tests/unit/ResolveWorkspaceIdCase.test.ts — issue #320.
 *
 * `sync/resolveWorkspaceId` matched names with `WHERE name = ?` while the other
 * two resolvers in the codebase compare case-insensitively:
 *
 *   ToolBatchExecutionService.validateWorkspaceId  name.toLowerCase() === id.toLowerCase()
 *   WorkspaceService.getWorkspaceByNameOrId        ws.name.toLowerCase() === lookupName.toLowerCase()
 *   sync/resolveWorkspaceId                        WHERE name = ?            <- the outlier
 *
 * The third is the one wired into TaskService (AgentInitializationService), so a
 * name differing only in case was ACCEPTED by the envelope guard and then
 * rejected one layer down with "Workspace ... not found. Call loadWorkspace or
 * createWorkspace first" — telling the caller to create a workspace that exists.
 *
 * Aligned to the other two rather than the reverse: `getWorkspaceByNameOrId` is
 * the canonical resolver, and the guard's lowercasing predates the guard going
 * live, so `name = ?` is the odd one out.
 *
 * NOTE: `isArchived = 0` is deliberately untouched here. How a name is compared
 * is a separate decision from which rows are eligible, and the archived
 * exclusion is pinned below so a future change to it is a conscious one.
 */
import { resolveWorkspaceId } from '../../src/database/sync/resolveWorkspaceId';
import type { ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';

interface Row { id: string; name: string; isArchived: number; lastAccessed: number }

const ROWS: Row[] = [
    { id: 'a8fbad11-7412-49c8-bce0-5690e2c1d197', name: 'Desenvolvedor', isArchived: 0, lastAccessed: 3 },
    { id: 'b1000000-0000-0000-0000-000000000002', name: 'Dev', isArchived: 0, lastAccessed: 2 },
    { id: 'd3000000-0000-0000-0000-000000000004', name: 'Retired', isArchived: 1, lastAccessed: 1 },
];

/**
 * Executes the resolver's real SQL against in-memory rows, honouring whichever
 * comparison the query actually asks for. The point of these cases is the SQL
 * itself, so the mock must not paper over it: `name = ?` stays case-sensitive
 * here exactly as SQLite would treat it.
 */
function createCache(rows: Row[] = ROWS): ISQLiteCacheManager {
    const nameMatches = (sql: string, rowName: string, param: string): boolean =>
        /LOWER\(\s*name\s*\)/i.test(sql)
            ? rowName.toLowerCase() === param.toLowerCase()
            : rowName === param;

    return {
        queryOne: jest.fn(async (sql: string, params: unknown[]) => {
            if (/FROM workspaces WHERE id = \?/i.test(sql)) {
                return rows.find(row => row.id === params[0]) ?? null;
            }
            return null;
        }),
        query: jest.fn(async (sql: string, params: unknown[]) => {
            if (/FROM workspaces WHERE/i.test(sql)) {
                return rows.filter(row =>
                    nameMatches(sql, row.name, String(params[0]))
                    && (!/isArchived = 0/i.test(sql) || row.isArchived === 0)
                );
            }
            return [];
        }),
    } as unknown as ISQLiteCacheManager;
}

describe('resolveWorkspaceId name matching (issue #320)', () => {
    it('resolves a name differing only in case', async () => {
        // The reported failure: the envelope guard accepted "desenvolvedor",
        // then TaskService's resolver threw "Workspace not found".
        const result = await resolveWorkspaceId('desenvolvedor', createCache());

        expect(result.id).toBe('a8fbad11-7412-49c8-bce0-5690e2c1d197');
        expect(result.resolvedFromName).toBe(true);
    });

    it('resolves an all-caps name', async () => {
        expect((await resolveWorkspaceId('DESENVOLVEDOR', createCache())).id)
            .toBe('a8fbad11-7412-49c8-bce0-5690e2c1d197');
    });

    it('still resolves the exact name (unchanged)', async () => {
        const result = await resolveWorkspaceId('Desenvolvedor', createCache());

        expect(result.id).toBe('a8fbad11-7412-49c8-bce0-5690e2c1d197');
        expect(result.resolvedFromName).toBe(true);
    });

    it('still prefers a direct id match over any name lookup', async () => {
        const result = await resolveWorkspaceId('b1000000-0000-0000-0000-000000000002', createCache());

        expect(result.id).toBe('b1000000-0000-0000-0000-000000000002');
        expect(result.resolvedFromName).toBe(false);
    });

    it('still returns null for a name that matches nothing', async () => {
        expect((await resolveWorkspaceId('no-such-workspace', createCache())).id).toBeNull();
    });

    it('still excludes archived workspaces, in any case form', async () => {
        // Case-insensitivity must not quietly widen row eligibility — these are
        // separate decisions, and this pins the one that was NOT changed.
        expect((await resolveWorkspaceId('Retired', createCache())).id).toBeNull();
        expect((await resolveWorkspaceId('retired', createCache())).id).toBeNull();
    });

    it('still reports ambiguity when several workspaces share a name', async () => {
        const duplicates: Row[] = [
            { id: 'id-one', name: 'Shared', isArchived: 0, lastAccessed: 2 },
            { id: 'id-two', name: 'shared', isArchived: 0, lastAccessed: 1 },
        ];
        // Case-folding makes these two collide where they previously did not, so
        // the ambiguity branch must report both rather than silently pick one.
        const result = await resolveWorkspaceId('SHARED', createCache(duplicates));

        expect(result.id).toBeNull();
        expect(result.matchingIds).toEqual(['id-one', 'id-two']);
        expect(result.warning).toMatch(/Multiple workspaces named "SHARED"/);
    });
});
