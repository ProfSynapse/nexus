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
                const matched = rows.filter(row =>
                    nameMatches(sql, row.name, String(params[0]))
                    && (!/isArchived = 0/i.test(sql) || row.isArchived === 0)
                );
                // Honour the query's own ordering so the message order under test
                // is the order SQLite would actually produce.
                if (/ORDER BY\s+lastAccessed\s+DESC/i.test(sql)) {
                    return [...matched].sort((a, b) => b.lastAccessed - a.lastAccessed || a.id.localeCompare(b.id));
                }
                return matched;
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

    /**
     * Case-folding makes `Dev` and `dev` collide where they previously resolved
     * separately — the schema permits both, since `UNIQUE(name)` on the
     * workspaces table has no COLLATE NOCASE. So the ambiguity branch is now
     * reachable in a way it effectively was not before, and it has to be
     * actionable: listing bare UUIDs is useless when the candidates differ ONLY
     * in capitalization, because the caller cannot tell which is which.
     */
    describe('ambiguous name reporting', () => {
        const duplicates: Row[] = [
            { id: 'b1000000-0000-0000-0000-000000000002', name: 'Dev', isArchived: 0, lastAccessed: 2 },
            { id: 'e4000000-0000-0000-0000-000000000005', name: 'dev', isArchived: 0, lastAccessed: 9 },
        ];

        it('reports every match with BOTH its name and its id', async () => {
            const result = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(result.id).toBeNull();
            for (const row of duplicates) {
                expect(result.warning).toContain(row.name);
                expect(result.warning).toContain(row.id);
            }
        });

        it('pairs each name with its own id, not just lists both separately', async () => {
            // The whole point is telling the two apart, so name and id must be
            // adjacent in the text rather than in two unrelated lists.
            const { warning } = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(warning).toMatch(/"Dev"[^\n]*b1000000-0000-0000-0000-000000000002/);
            expect(warning).toMatch(/"dev"[^\n]*e4000000-0000-0000-0000-000000000005/);
        });

        it('tells the caller to retry with the id', async () => {
            const { warning } = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(warning).toMatch(/workspaceId/i);
            expect(warning).toMatch(/\bid\b/i);
        });

        it('exposes the matches structurally, not only in prose', async () => {
            const result = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(result.matches).toEqual([
                { id: 'e4000000-0000-0000-0000-000000000005', name: 'dev' },
                { id: 'b1000000-0000-0000-0000-000000000002', name: 'Dev' },
            ]);
        });

        it('keeps matchingIds populated for existing callers', async () => {
            // AgentInitializationService gates on matchingIds.length > 1 to decide
            // whether to throw, so this stays a supported field.
            const result = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(result.matchingIds).toHaveLength(2);
            expect(result.matchingIds).toEqual(expect.arrayContaining(duplicates.map(d => d.id)));
        });

        it('orders candidates most-recently-accessed first', async () => {
            // Deterministic, and the likeliest intended workspace leads.
            const { matches } = await resolveWorkspaceId('DEV', createCache(duplicates));

            expect(matches?.[0].name).toBe('dev');
        });
    });
});
