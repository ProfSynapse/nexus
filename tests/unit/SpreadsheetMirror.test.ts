/**
 * Phase 1 (mirror generation) tests — the pure projection core: CSV
 * serialization, byte-budget sharding, the WorkbookMirrorService (idempotency,
 * sharding, sheet-name collisions, stale-shard cleanup), the HucreXlsxSource
 * value mapping (fake module), and the pinned hucre asset manifest.
 *
 * Reuses the in-memory DataAdapter fake shape from the other storage tests.
 */

import type { DataAdapter } from 'obsidian';
import { serializeRows, serializeRow, utf8Bytes } from '../../src/agents/apps/dataAnalysis/spreadsheet/csv';
import { shardSheet } from '../../src/agents/apps/dataAnalysis/spreadsheet/shard';
import { WorkbookMirrorService } from '../../src/agents/apps/dataAnalysis/spreadsheet/WorkbookMirrorService';
import { HucreXlsxSource, fnv1aHex } from '../../src/agents/apps/dataAnalysis/spreadsheet/HucreXlsxSource';
import { buildHucreAssetManifest, HUCRE_VERSION } from '../../src/agents/apps/dataAnalysis/spreadsheet/HucreAssets';
import type { MirrorManifest, ParsedWorkbook } from '../../src/agents/apps/dataAnalysis/spreadsheet/types';

function makeAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const norm = (p: string) => p.replace(/\/+$/, '');
  const immediateChildren = (dir: string) => {
    const prefix = norm(dir) + '/';
    const childFiles: string[] = [];
    const childFolders: string[] = [];
    for (const f of files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) childFiles.push(f);
    }
    for (const f of folders) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) childFolders.push(f);
    }
    return { files: childFiles, folders: childFolders };
  };
  const adapter = {
    async exists(path: string) { const p = norm(path); return files.has(p) || folders.has(p); },
    async list(path: string) { return immediateChildren(path); },
    async read(path: string) {
      const p = norm(path);
      if (!files.has(p)) throw new Error(`no such file: ${p}`);
      return files.get(p) as string;
    },
    async write(path: string, data: string) {
      const p = norm(path);
      const segs = p.split('/');
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) { cur = cur ? `${cur}/${segs[i]}` : segs[i]; folders.add(cur); }
      files.set(p, data);
    },
    async mkdir(path: string) { const p = norm(path); if (folders.has(p)) throw new Error('exists'); folders.add(p); },
    async remove(path: string) { files.delete(norm(path)); },
    async rmdir(path: string) { folders.delete(norm(path)); },
  };
  return { adapter: adapter as unknown as DataAdapter, files, folders };
}

const TARGET = { root: 'Nexus', workbookId: 'budget', maxShardBytes: 1_000_000, now: () => Date.parse('2026-05-31T00:00:00Z') };

describe('csv serialization', () => {
  it('quotes values containing comma, quote, or newline (RFC-4180); LF lines', () => {
    expect(serializeRow(['a', 'b,c', 'he said "hi"', 'line\nbreak'])).toBe('a,"b,c","he said ""hi""","line\nbreak"');
    expect(serializeRow([1, true, false, null])).toBe('1,TRUE,FALSE,');
    expect(serializeRows([['a', 1], ['b', 2]])).toBe('a,1\nb,2\n');
    expect(serializeRows([])).toBe('');
  });
});

describe('shardSheet', () => {
  it('empty sheet yields a single empty shard', () => {
    expect(shardSheet([], 1000)).toEqual([{ csv: '', startRow: 0, endRow: 0, bytes: 0 }]);
  });

  it('splits rows into contiguous shards under the byte budget', () => {
    const rows = Array.from({ length: 10 }, (_, i) => [`row${i}`, i]);
    const oneRowBytes = utf8Bytes(serializeRow(rows[0])) + 1;
    const shards = shardSheet(rows, oneRowBytes * 3); // ~3 rows per shard

    expect(shards.length).toBeGreaterThan(1);
    // contiguous, complete coverage
    expect(shards[0].startRow).toBe(0);
    expect(shards[shards.length - 1].endRow).toBe(10);
    for (let i = 1; i < shards.length; i++) expect(shards[i].startRow).toBe(shards[i - 1].endRow);
    for (const s of shards) expect(s.bytes).toBeLessThanOrEqual(oneRowBytes * 3);
  });

  it('a lone oversize row gets its own shard rather than looping', () => {
    const rows = [['x'.repeat(5000)], ['small']];
    const shards = shardSheet(rows, 100);
    expect(shards[0]).toMatchObject({ startRow: 0, endRow: 1 });
    expect(shards.length).toBe(2);
  });
});

describe('WorkbookMirrorService', () => {
  const wb = (sourceHash: string): ParsedWorkbook => ({
    sourceHash,
    sheets: [
      { name: 'Data', rows: [['region', 'amount'], ['EMEA', 100], ['APAC', 200]], formulaCells: ['B4'] },
      { name: 'Summary', rows: [['total', 300]] },
    ],
  });

  it('writes manifest + per-sheet CSV shards under <root>/spreadsheets/<id>', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new WorkbookMirrorService(adapter);

    const { manifest, regenerated } = await svc.generate(wb('h1'), TARGET);

    expect(regenerated).toBe(true);
    expect(manifest.sourceHash).toBe('h1');
    expect(manifest.sheets.map((s) => s.name)).toEqual(['Data', 'Summary']);
    expect(manifest.sheets[0].formulaCells).toEqual(['B4']);
    expect(files.get('Nexus/spreadsheets/budget/Data.part0.csv')).toBe('region,amount\nEMEA,100\nAPAC,200\n');
    expect(files.get('Nexus/spreadsheets/budget/Summary.part0.csv')).toBe('total,300\n');
    expect(files.has('Nexus/spreadsheets/budget/manifest.json')).toBe(true);
  });

  it('is idempotent: same sourceHash skips the rewrite', async () => {
    const { adapter } = makeAdapter();
    const svc = new WorkbookMirrorService(adapter);
    await svc.generate(wb('h1'), TARGET);
    const second = await svc.generate(wb('h1'), TARGET);
    expect(second.regenerated).toBe(false);
  });

  it('a changed sourceHash regenerates and clears stale shards (but not _archive)', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new WorkbookMirrorService(adapter);
    await svc.generate(wb('h1'), TARGET);
    // simulate a prior larger sheet leaving an extra shard + an archive snapshot
    await adapter.write('Nexus/spreadsheets/budget/Data.part9.csv', 'stale');
    await adapter.write('Nexus/spreadsheets/budget/_archive/old/Data.part0.csv', 'snapshot');

    const second = await svc.generate(wb('h2'), TARGET);
    expect(second.regenerated).toBe(true);
    expect(files.has('Nexus/spreadsheets/budget/Data.part9.csv')).toBe(false);      // stale shard cleared
    expect(files.get('Nexus/spreadsheets/budget/_archive/old/Data.part0.csv')).toBe('snapshot'); // archive preserved
  });

  it('disambiguates colliding sanitized sheet names', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new WorkbookMirrorService(adapter);
    const collide: ParsedWorkbook = {
      sourceHash: 'h',
      sheets: [
        { name: 'Q1/Q2', rows: [['a']] },
        { name: 'Q1:Q2', rows: [['b']] },
      ],
    };
    await svc.generate(collide, TARGET);
    // both sanitize to "Q1_Q2"; the second is disambiguated by order
    expect(files.get('Nexus/spreadsheets/budget/Q1_Q2.part0.csv')).toBe('a\n');
    expect(files.get('Nexus/spreadsheets/budget/Q1_Q2-1.part0.csv')).toBe('b\n');
  });
});

describe('HucreXlsxSource', () => {
  it('maps hucre reader output to a ParsedWorkbook with a content hash', async () => {
    const fakeModule = {
      async readXlsx(_bytes: Uint8Array) {
        return { sheets: [{ name: 'S', rows: [['x', 1, true, null, new Date('2026-01-02T00:00:00Z')]] }], hasMacros: true };
      },
    };
    const src = new HucreXlsxSource(async () => fakeModule);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const wb = await src.readWorkbook(bytes);

    expect(wb.hasMacros).toBe(true);
    expect(wb.sheets[0].rows[0]).toEqual(['x', 1, true, null, '2026-01-02T00:00:00.000Z']);
    expect(wb.sourceHash).toBe(fnv1aHex(bytes));
  });

  it('fnv1aHex is stable and content-sensitive', () => {
    expect(fnv1aHex(new Uint8Array([1, 2, 3]))).toBe(fnv1aHex(new Uint8Array([1, 2, 3])));
    expect(fnv1aHex(new Uint8Array([1, 2, 3]))).not.toBe(fnv1aHex(new Uint8Array([1, 2, 4])));
  });
});

describe('hucre asset manifest', () => {
  it('pins a single bundled xlsx asset at the locked version', () => {
    const manifest = buildHucreAssetManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].url).toContain(`hucre@${HUCRE_VERSION}/xlsx`);
    expect(manifest[0].minBytes).toBeGreaterThan(0);
  });
});
