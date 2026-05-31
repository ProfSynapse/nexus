/**
 * SkillUsageService Unit Tests
 *
 * Verifies the cross-workspace usage-history query (§9): the LIKE-prefilter +
 * JS-confirm discards false positives, surviving rows group by workspaceId,
 * recentActions/recentFiles are built from canonical trace metadata, totalUsages
 * and lastUsedAt are correct, and states is always [] (out of scope this slice).
 * SQLite is mocked with jest.fn() — no real DB.
 */

import { SkillUsageService } from '../../src/agents/apps/skills/services/SkillUsageService';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';

type MockSqlite = {
  query: jest.Mock;
};

function makeService(rows: unknown[]): { service: SkillUsageService; mock: MockSqlite } {
  const mock: MockSqlite = {
    query: jest.fn().mockResolvedValue(rows),
  };
  return { service: new SkillUsageService(mock as unknown as SQLiteCacheManager), mock };
}

const SKILL_ID = 'claude/essay-editor';

/** Build a memory_traces row with a canonical-ish metadataJson blob. */
function row(opts: {
  id: string;
  workspaceId: string;
  timestamp: number;
  activeSkills?: string[];
  toolId?: string;
  files?: string[];
  content?: string;
  rawMetadata?: string; // override to inject malformed/false-positive JSON
}): Record<string, unknown> {
  const metadata =
    opts.rawMetadata !== undefined
      ? opts.rawMetadata
      : JSON.stringify({
          schemaVersion: 1,
          tool: opts.toolId
            ? { id: opts.toolId, agent: opts.toolId.split('.')[0], mode: opts.toolId.split('.')[1] }
            : undefined,
          context: { workspaceId: opts.workspaceId, sessionId: 's-1' },
          input: opts.files ? { files: opts.files } : undefined,
          outcome: { success: true },
          ...(opts.activeSkills ? { activeSkills: opts.activeSkills } : {}),
        });

  return {
    id: opts.id,
    workspaceId: opts.workspaceId,
    sessionId: 's-1',
    timestamp: opts.timestamp,
    type: 'tool_call',
    content: opts.content ?? 'did something',
    metadataJson: metadata,
  };
}

describe('SkillUsageService', () => {
  it('discards a LIKE false-positive whose activeSkills does not actually contain the id', async () => {
    // This row's metadataJson contains the substring "claude/essay-editor" (so
    // it passes the SQL LIKE prefilter) but only inside a DIFFERENT field — the
    // activeSkills array holds a different skill. It must be discarded.
    const falsePositive = row({
      id: 't-fp',
      workspaceId: 'ws-other',
      timestamp: 5000,
      // activeSkills holds a different id; the target id appears only in content.
      activeSkills: ['codex/other-skill'],
      content: 'note about claude/essay-editor mentioned in passing',
    });
    const real = row({
      id: 't-real',
      workspaceId: 'ws-blog',
      timestamp: 4000,
      activeSkills: [SKILL_ID],
      toolId: 'contentManager.replace',
    });

    const { service } = makeService([falsePositive, real]);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.totalUsages).toBe(1);
    expect(history.byWorkspace).toHaveLength(1);
    expect(history.byWorkspace[0].workspaceId).toBe('ws-blog');
  });

  it('groups surviving rows by workspaceId and builds recentActions', async () => {
    const rows = [
      row({ id: 't1', workspaceId: 'ws-blog', timestamp: 3000, activeSkills: [SKILL_ID], toolId: 'contentManager.replace', content: 'tightened the intro' }),
      row({ id: 't2', workspaceId: 'ws-blog', timestamp: 2000, activeSkills: [SKILL_ID], toolId: 'contentManager.write', content: 'wrote a paragraph' }),
      row({ id: 't3', workspaceId: 'ws-jobs', timestamp: 1000, activeSkills: [SKILL_ID, 'codex/x'], toolId: 'contentManager.replace', content: 'edited cover letter' }),
    ];

    const { service } = makeService(rows);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.totalUsages).toBe(3);
    expect(history.byWorkspace).toHaveLength(2);

    const blog = history.byWorkspace.find((w) => w.workspaceId === 'ws-blog')!;
    expect(blog.recentActions).toHaveLength(2);
    expect(blog.recentActions[0]).toMatchObject({ tool: 'contentManager.replace', summary: 'tightened the intro', at: 3000 });

    const jobs = history.byWorkspace.find((w) => w.workspaceId === 'ws-jobs')!;
    expect(jobs.recentActions).toHaveLength(1);
    expect(jobs.recentActions[0].tool).toBe('contentManager.replace');
  });

  it('derives recentFiles from canonical input.files', async () => {
    const rows = [
      row({ id: 't1', workspaceId: 'ws-blog', timestamp: 3000, activeSkills: [SKILL_ID], toolId: 'contentManager.replace', files: ['essays/essay-draft-3.md'] }),
    ];

    const { service } = makeService(rows);
    const history = await service.getUsageHistory(SKILL_ID);

    const blog = history.byWorkspace[0];
    expect(blog.recentFiles).toHaveLength(1);
    expect(blog.recentFiles[0]).toMatchObject({
      path: 'essays/essay-draft-3.md',
      action: 'contentManager.replace',
      at: 3000,
    });
  });

  it('computes totalUsages and lastUsedAt as the max surviving timestamp', async () => {
    const rows = [
      row({ id: 't1', workspaceId: 'ws-blog', timestamp: 7000, activeSkills: [SKILL_ID] }),
      row({ id: 't2', workspaceId: 'ws-blog', timestamp: 9000, activeSkills: [SKILL_ID] }),
      row({ id: 't3', workspaceId: 'ws-jobs', timestamp: 1000, activeSkills: [SKILL_ID] }),
    ];

    const { service } = makeService(rows);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.totalUsages).toBe(3);
    expect(history.lastUsedAt).toBe(9000);
  });

  it('always returns states === [] (out of scope this slice)', async () => {
    const rows = [
      row({ id: 't1', workspaceId: 'ws-blog', timestamp: 3000, activeSkills: [SKILL_ID] }),
    ];

    const { service } = makeService(rows);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.byWorkspace[0].states).toEqual([]);
  });

  it('skips rows with malformed metadataJson without throwing', async () => {
    const rows = [
      row({ id: 't-bad', workspaceId: 'ws-x', timestamp: 5000, rawMetadata: '{ this is "claude/essay-editor" not valid json' }),
      row({ id: 't-good', workspaceId: 'ws-blog', timestamp: 4000, activeSkills: [SKILL_ID] }),
    ];

    const { service } = makeService(rows);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.totalUsages).toBe(1);
    expect(history.byWorkspace[0].workspaceId).toBe('ws-blog');
  });

  it('returns an empty history with no lastUsedAt when no rows survive', async () => {
    const { service } = makeService([]);
    const history = await service.getUsageHistory(SKILL_ID);

    expect(history.totalUsages).toBe(0);
    expect(history.lastUsedAt).toBeUndefined();
    expect(history.byWorkspace).toEqual([]);
  });

  it('passes the JSON-encoded skillId as the LIKE param and the limit', async () => {
    const { service, mock } = makeService([]);
    await service.getUsageHistory(SKILL_ID, 25);

    expect(mock.query).toHaveBeenCalledTimes(1);
    const [, params] = mock.query.mock.calls[0];
    expect(params).toEqual([`%"${SKILL_ID}"%`, 25]);
  });
});
