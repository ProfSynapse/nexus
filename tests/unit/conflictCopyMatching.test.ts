/**
 * Test-as-spec for conflict-copy shard filename matching.
 *
 * Locks in the regex behavior added by Phase 1 of the sync-safe-storage
 * reconcile work (see `docs/plans/sync-safe-storage-reconcile-plan.md` and
 * `docs/architecture/sync-safe-storage-reconcile-adjustments.md`). The 16
 * fixtures below are ported verbatim from the preparer's §A.4 corpus and
 * exercise both reader (`ShardedJsonlStreamStore`) and watcher
 * (`JsonlVaultWatcher`) regex sites.
 *
 * Production code is imported directly — patterns are NOT duplicated here.
 * If the regexes drift, this file fails first.
 */

import {
  parseShardFileNameWithConflict,
  SHARD_FILE_PATTERN,
  SHARD_CONFLICT_PATTERN
} from '../../src/database/storage/vaultRoot/ShardedJsonlStreamStore';
import {
  MATCH_SHARDED,
  MATCH_FLAT
} from '../../src/database/sync/JsonlVaultWatcher';

interface ParserExpectation {
  fileName: string;
  expected:
    | { kind: 'canonical'; baseIndex: number }
    | { kind: 'conflict'; baseIndex: number; conflictMarker: string }
    | { kind: 'reject' };
  notes: string;
}

const PARSER_FIXTURES: ParserExpectation[] = [
  // Canonical
  { fileName: 'shard-000001.jsonl',                                                     expected: { kind: 'canonical', baseIndex: 1 },                                  notes: '' },
  { fileName: 'shard-1.jsonl',                                                          expected: { kind: 'canonical', baseIndex: 1 },                                  notes: '' },
  { fileName: 'shard-0000012.jsonl',                                                    expected: { kind: 'canonical', baseIndex: 12 },                                 notes: 'tightest false-positive case' },
  // Conflict copies
  { fileName: 'shard-000001 (1).jsonl',                                                 expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '(1)' },             notes: 'GDrive numeric' },
  { fileName: 'shard-000001 (2).jsonl',                                                 expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '(2)' },             notes: 'GDrive numeric' },
  { fileName: 'shard-000001 [Conflict].jsonl',                                          expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '[Conflict]' },      notes: 'GDrive modern' },
  { fileName: 'shard-000001_conf(1).jsonl',                                             expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '(1)' },             notes: 'GDrive _conf variant' },
  { fileName: 'shard-000001 (Conflicted copy 2026-05-06).jsonl',                        expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '(Conflicted copy 2026-05-06)' }, notes: 'defensive Dropbox-style' },
  { fileName: "shard-000001 (joseph's conflicted copy 2026-05-06 14-22-01).jsonl",      expected: { kind: 'conflict', baseIndex: 1, conflictMarker: "(joseph's conflicted copy 2026-05-06 14-22-01)" }, notes: 'Dropbox' },
  { fileName: 'shard-000001 2.jsonl',                                                   expected: { kind: 'conflict', baseIndex: 1, conflictMarker: '2' },               notes: 'iCloud' },
  // Rejects
  { fileName: 'shard-000001-backup.jsonl',                                              expected: { kind: 'reject' },                                                    notes: 'reject' },
  { fileName: 'shard-abc.jsonl',                                                        expected: { kind: 'reject' },                                                    notes: 'reject' },
  { fileName: 'manifest.jsonl',                                                         expected: { kind: 'reject' },                                                    notes: 'reject' },
  { fileName: 'shard-000001.jsonl.tmp',                                                 expected: { kind: 'reject' },                                                    notes: 'reject' },
  { fileName: 'shard-000001-old.jsonl',                                                 expected: { kind: 'reject' },                                                    notes: 'reject' },
  { fileName: 'shard-000001-backup-2.jsonl',                                            expected: { kind: 'reject' },                                                    notes: 'reject' }
];

describe('parseShardFileNameWithConflict (preparer §A.4 corpus)', () => {
  it.each(PARSER_FIXTURES)('parses $fileName', ({ fileName, expected }) => {
    const parsed = parseShardFileNameWithConflict(fileName);

    if (expected.kind === 'reject') {
      expect(parsed).toBeNull();
      return;
    }

    expect(parsed).not.toBeNull();
    expect(parsed!.baseIndex).toBe(expected.baseIndex);

    if (expected.kind === 'canonical') {
      expect(parsed!.conflictMarker).toBeNull();
    } else {
      expect(parsed!.conflictMarker).toBe(expected.conflictMarker);
    }
  });

  it('canonical fast-path is anchored', () => {
    expect(SHARD_FILE_PATTERN.test('shard-000001.jsonl')).toBe(true);
    expect(SHARD_FILE_PATTERN.test('prefix shard-000001.jsonl')).toBe(false);
    expect(SHARD_FILE_PATTERN.test('shard-000001.jsonl suffix')).toBe(false);
  });

  it('conflict pattern is anchored', () => {
    expect(SHARD_CONFLICT_PATTERN.test('shard-000001 (1).jsonl')).toBe(true);
    expect(SHARD_CONFLICT_PATTERN.test('prefix shard-000001 (1).jsonl')).toBe(false);
  });
});

interface WatcherExpectation {
  relativePath: string;
  expected: 'match' | 'reject';
  notes: string;
}

const WATCHER_SHARDED_FIXTURES: WatcherExpectation[] = [
  { relativePath: 'conversations/conv_abc/shard-000001.jsonl',                                                     expected: 'match',  notes: 'canonical' },
  { relativePath: 'conversations/conv_abc/shard-1.jsonl',                                                          expected: 'match',  notes: 'canonical short' },
  { relativePath: 'conversations/conv_abc/shard-0000012.jsonl',                                                    expected: 'match',  notes: 'canonical, false-positive guard' },
  { relativePath: 'conversations/conv_abc/shard-000001 (1).jsonl',                                                 expected: 'match',  notes: 'GDrive numeric' },
  { relativePath: 'workspaces/ws_xyz/shard-000001 [Conflict].jsonl',                                               expected: 'match',  notes: 'GDrive modern' },
  { relativePath: 'tasks/tasks_xyz/shard-000001_conf(1).jsonl',                                                    expected: 'match',  notes: 'GDrive _conf variant' },
  { relativePath: 'tasks/tasks_xyz/shard-000001 (Conflicted copy 2026-05-06).jsonl',                               expected: 'match',  notes: 'Dropbox-style' },
  { relativePath: "tasks/tasks_xyz/shard-000001 (joseph's conflicted copy 2026-05-06 14-22-01).jsonl",             expected: 'match',  notes: 'Dropbox' },
  { relativePath: 'conversations/conv_abc/shard-000001 2.jsonl',                                                   expected: 'match',  notes: 'iCloud bare-digit' },
  { relativePath: 'conversations/conv_abc/shard-000001-backup.jsonl',                                              expected: 'reject', notes: 'reject — hyphen-separated suffix' },
  { relativePath: 'conversations/conv_abc/shard-abc.jsonl',                                                        expected: 'reject', notes: 'reject — non-numeric base' },
  { relativePath: 'conversations/_meta/storage-manifest.json',                                                     expected: 'reject', notes: 'reject — wrong extension' }
];

describe('JsonlVaultWatcher MATCH_SHARDED (symmetric with reader)', () => {
  it.each(WATCHER_SHARDED_FIXTURES)('$relativePath -> $expected', ({ relativePath, expected }) => {
    const matched = MATCH_SHARDED.test(relativePath);
    expect(matched).toBe(expected === 'match');
  });
});

describe('JsonlVaultWatcher MATCH_FLAT (legacy flat layout, conflict-aware)', () => {
  it('matches canonical flat shard', () => {
    expect(MATCH_FLAT.test('conversations/conv_abc.jsonl')).toBe(true);
  });

  it('matches conflict-suffixed flat shard', () => {
    expect(MATCH_FLAT.test('workspaces/ws_xyz [Conflict].jsonl')).toBe(true);
    expect(MATCH_FLAT.test('tasks/tasks_xyz (1).jsonl')).toBe(true);
  });

  it('rejects non-shard paths', () => {
    expect(MATCH_FLAT.test('some/other/file.jsonl')).toBe(false);
    expect(MATCH_FLAT.test('conversations/not-a-shard.txt')).toBe(false);
  });
});
