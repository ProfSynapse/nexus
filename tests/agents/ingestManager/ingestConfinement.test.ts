/**
 * Regression test: the ingestion pipeline confines the caller-supplied input
 * path to the vault. `buildOutputPath` derives the output note (and OCR asset
 * folder) directly from `request.filePath`, so an escaping input must be rejected
 * before any write.
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { processFile } from '@/agents/ingestManager/tools/services/IngestionPipelineService';

// A POSIX leading slash (/tmp/ESCAPE.pdf) is stripped to vault-relative (backward-compat), not an escape.
const ESCAPING = ['../../../../tmp/ESCAPE.pdf', '~/ESCAPE.pdf'];

function makeDeps(): { deps: any; vault: any } {
  const vault = {
    getFileByPath: jest.fn().mockReturnValue(null),
    getFolderByPath: jest.fn().mockReturnValue(null),
    readBinary: jest.fn(),
    create: jest.fn(),
    modify: jest.fn(),
    createBinary: jest.fn(),
    createFolder: jest.fn(),
  };
  const deps = { vault, ocrDeps: {}, transcriptionService: {} };
  return { deps, vault };
}

describe('processFile input-path confinement', () => {
  it.each(ESCAPING)('rejects escaping filePath %s with no write', async (filePath) => {
    const { deps, vault } = makeDeps();
    const result = await processFile({ filePath }, deps);
    expect(result.success).toBe(false);
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.createBinary).not.toHaveBeenCalled();
    expect(vault.createFolder).not.toHaveBeenCalled();
    // The rejection is the confinement error, not a downstream "file not found".
    expect(result.error).toMatch(/\.\.|absolute|~/);
  });

  it('a normal (non-existent) path passes confinement and fails only on file lookup', async () => {
    const { deps } = makeDeps();
    const result = await processFile({ filePath: 'inbox/report.pdf' }, deps);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
