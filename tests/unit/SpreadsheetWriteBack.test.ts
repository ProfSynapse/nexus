/**
 * Phase 2 (write-back) tests. The hucre engine is faked with a "JSON-as-xlsx"
 * source/writer so the REAL logic under test — CSV parse, cell diff, formula
 * guard, snapshot, re-projection, divergence/dryRun handling — runs end-to-end
 * over the in-memory adapter with the real WorkbookMirrorService +
 * SnapshotArchiveService.
 */

import type { DataAdapter } from 'obsidian';
import { parseCsv, serializeRows } from '../../src/agents/apps/dataAnalysis/spreadsheet/csv';
import { WorkbookMirrorService } from '../../src/agents/apps/dataAnalysis/spreadsheet/WorkbookMirrorService';
import { WorkbookWriteBackService } from '../../src/agents/apps/dataAnalysis/spreadsheet/WorkbookWriteBackService';
import { SnapshotArchiveService } from '../../src/services/storage/SnapshotArchiveService';
import type { CellWrite, ParsedWorkbook, XlsxSource, XlsxWriter } from '../../src/agents/apps/dataAnalysis/spreadsheet/types';

function makeAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const norm = (p: string) => p.replace(/\/+$/, '');
  const children = (dir: string) => {
    const prefix = norm(dir) + '/';
    const f: string[] = [];
    const d: string[] = [];
    for (const k of files.keys()) if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) f.push(k);
    for (const k of folders) if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) d.push(k);
    return { files: f, folders: d };
  };
  const adapter = {
    async exists(p: string) { const n = norm(p); return files.has(n) || folders.has(n); },
    async list(p: string) { return children(p); },
    async read(p: string) { const n = norm(p); if (!files.has(n)) throw new Error(`no file ${n}`); return files.get(n) as string; },
    async write(p: string, data: string) {
      const n = norm(p);
      const segs = n.split('/');
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) { cur = cur ? `${cur}/${segs[i]}` : segs[i]; folders.add(cur); }
      files.set(n, data);
    },
    async mkdir(p: string) { const n = norm(p); if (folders.has(n)) throw new Error('exists'); folders.add(n); },
    async remove(p: string) { files.delete(norm(p)); },
    async rmdir(p: string) { folders.delete(norm(p)); },
  };
  return { adapter: adapter as unknown as DataAdapter, files, folders };
}

const enc = (wb: ParsedWorkbook) => new TextEncoder().encode(JSON.stringify(wb));
const dec = (b: Uint8Array): ParsedWorkbook => JSON.parse(new TextDecoder().decode(b)) as ParsedWorkbook;

/** JSON-as-xlsx engine fakes — exercise the real orchestration without hucre. */
const fakeSource: XlsxSource = { async readWorkbook(b) { return dec(b); } };

class FakeWriter implements XlsxWriter {
  lastWrites: CellWrite[] = [];
  async applyCellWrites(bytes: Uint8Array, writes: CellWrite[]): Promise<Uint8Array> {
    this.lastWrites = writes;
    const wb = dec(bytes);
    for (const w of writes) {
      const sheet = wb.sheets.find((s) => s.name === w.sheet)!;
      while (sheet.rows.length <= w.row) sheet.rows.push([]);
      const row = sheet.rows[w.row];
      while (row.length <= w.col) row.push(null);
      row[w.col] = w.value;
    }
    wb.sourceHash = `${wb.sourceHash}-applied`;
    return enc(wb);
  }
}

const TARGET = { root: 'Nexus', workbookId: 'budget', maxShardBytes: 1_000_000, now: () => 0 };

function baseWorkbook(hash = 'h1', formulaCells: string[] = []): ParsedWorkbook {
  return {
    sourceHash: hash,
    sheets: [{ name: 'Data', rows: [['region', 'amount'], ['EMEA', 100], ['APAC', 200]], formulaCells }],
  };
}

async function setup(formulaCells: string[] = []) {
  const { adapter, files } = makeAdapter();
  const mirror = new WorkbookMirrorService(adapter);
  const snapshot = new SnapshotArchiveService(adapter, { now: () => Date.parse('2026-05-31T00:00:00Z') });
  const writer = new FakeWriter();
  const wb = baseWorkbook('h1', formulaCells);
  await mirror.generate(wb, TARGET);
  const writeBack = new WorkbookWriteBackService(adapter, fakeSource, writer, mirror, snapshot);
  return { adapter, files, mirror, writer, writeBack, sourceBytes: enc(wb) };
}

const editShard = (files: Map<string, string>, content: string) =>
  files.set('Nexus/spreadsheets/budget/Data.part0.csv', content);

describe('parseCsv ↔ serializeRows round-trip', () => {
  it('parses quoted fields with commas, quotes, and newlines', () => {
    const rows = [['a', 'b,c'], ['he "q"', 'x\ny']];
    expect(parseCsv(serializeRows(rows))).toEqual([['a', 'b,c'], ['he "q"', 'x\ny']]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('WorkbookWriteBackService', () => {
  it('applies a data-cell edit: diff → write → snapshot → re-project', async () => {
    const { files, writer, writeBack, mirror, sourceBytes } = await setup();
    editShard(files, 'region,amount\nEMEA,999\nAPAC,200\n'); // EMEA 100 → 999 (B2)

    const res = await writeBack.apply(TARGET, sourceBytes);

    expect(res.applied).toBe(true);
    expect(res.reason).toBe('applied');
    expect(res.summary.cellsApplied).toBe(1);
    expect(res.summary.sheets[0].samples[0]).toEqual({ a1: 'B2', before: '100', after: '999' });
    // coerced back to a number for the write
    expect(writer.lastWrites).toEqual([{ sheet: 'Data', row: 1, col: 1, value: 999 }]);
    // snapshot captured the edited shard before re-projection
    expect(res.archivePath).toBeTruthy();
    expect(files.get(`${res.archivePath}/Data.part0.csv`)).toBe('region,amount\nEMEA,999\nAPAC,200\n');
    // mirror re-projected from the updated workbook (new hash)
    const manifest = await mirror.readManifest(TARGET);
    expect(manifest!.sourceHash).toBe('h1-applied');
  });

  it('formula-cell guard blocks an edit to a formula cell', async () => {
    const { files, writer, writeBack, sourceBytes } = await setup(['B3']); // APAC amount is a formula
    editShard(files, 'region,amount\nEMEA,100\nAPAC,300\n'); // tries to change B3

    const res = await writeBack.apply(TARGET, sourceBytes);

    expect(res.applied).toBe(false);
    expect(res.reason).toBe('no-changes');
    expect(res.summary.cellsApplied).toBe(0);
    expect(res.summary.cellsBlocked).toBe(1);
    expect(res.summary.sheets[0].blockedFormulaCells).toEqual(['B3']);
    expect(writer.lastWrites).toEqual([]);
  });

  it('dryRun returns the plan without writing or snapshotting', async () => {
    const { files, writeBack, sourceBytes } = await setup();
    editShard(files, 'region,amount\nEMEA,999\nAPAC,200\n');

    const res = await writeBack.apply(TARGET, sourceBytes, { dryRun: true });

    expect(res.applied).toBe(false);
    expect(res.reason).toBe('dry-run');
    expect(res.summary.cellsApplied).toBe(1);
    expect(res.newBytes).toBeUndefined();
    expect([...files.keys()].some((k) => k.includes('/_archive/'))).toBe(false);
  });

  it('refuses when the source diverged from the mirror (unless forced)', async () => {
    const { writeBack } = await setup();
    const diverged = enc(baseWorkbook('h2')); // different sourceHash than the mirror's h1

    const res = await writeBack.apply(TARGET, diverged);

    expect(res.applied).toBe(false);
    expect(res.reason).toBe('divergence');
  });

  it('no-op when nothing changed', async () => {
    const { writeBack, sourceBytes } = await setup();
    const res = await writeBack.apply(TARGET, sourceBytes); // shards untouched
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('no-changes');
  });
});
