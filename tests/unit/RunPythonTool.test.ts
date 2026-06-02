/**
 * Unit tests for RunPythonTool — the trusted-host orchestration around the
 * sandbox: desktop gating, parameter + path + size validation, output row-cap
 * enforcement, and result persistence. The Pyodide sandbox is faked so these
 * run without any WASM/Electron dependency.
 */

// Control the desktop gate deterministically.
jest.mock('../../src/utils/platform', () => ({
  isDesktop: jest.fn(() => true),
  isElectron: jest.fn(() => true),
}));

import { isDesktop } from '../../src/utils/platform';
import { RunPythonTool } from '../../src/agents/apps/dataAnalysis/tools/runPython';
import { DataAnalysisAgent } from '../../src/agents/apps/dataAnalysis/DataAnalysisAgent';
import { IAnalysisSandbox, SandboxRunRequest, SandboxRunResult } from '../../src/agents/apps/dataAnalysis/types';

const isDesktopMock = isDesktop as jest.Mock;

class FakeSandbox implements IAnalysisSandbox {
  lastRequest: SandboxRunRequest | null = null;
  constructor(private readonly result: SandboxRunResult) {}
  ensureReady(): Promise<void> {
    return Promise.resolve();
  }
  run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    this.lastRequest = request;
    return Promise.resolve(this.result);
  }
  dispose(): void {
    /* no-op */
  }
}

function makeVault(overrides: Record<string, unknown> = {}) {
  return {
    adapter: {
      readBinary: jest.fn(async () => new TextEncoder().encode('category,amount\nfood,10\n').buffer),
      write: jest.fn(async () => undefined),
    },
    getAbstractFileByPath: jest.fn(() => null),
    create: jest.fn(async () => undefined),
    createFolder: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as NonNullable<ReturnType<DataAnalysisAgent['getVault']>>;
}

function makeAgent(sandbox: IAnalysisSandbox, vault = makeVault()): DataAnalysisAgent {
  const agent = new DataAnalysisAgent();
  agent.setVault(vault);
  agent.setSandbox(sandbox);
  return agent;
}

const ctx = { memory: 'm', goal: 'g' } as never;

beforeEach(() => {
  isDesktopMock.mockReturnValue(true);
});

describe('RunPythonTool', () => {
  it('refuses on mobile', async () => {
    isDesktopMock.mockReturnValue(false);
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [] })));
    const res = await tool.execute({ code: 'x', context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/desktop-only/i);
  });

  it('rejects missing code', async () => {
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [] })));
    const res = await tool.execute({ code: '   ', context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Missing "code"/);
  });

  it('returns a successful bounded result', async () => {
    const data = [{ category: 'food', avg: 7.58 }];
    const sandbox = new FakeSandbox({ success: true, data, logs: ['ok'], stats: { durationMs: 12 } });
    const tool = new RunPythonTool(makeAgent(sandbox));
    const res = await tool.execute({ code: 'pd...', context: ctx });
    expect(res.success).toBe(true);
    const payload = res.data as { result: unknown; rows: number; logs: string[] };
    expect(payload.result).toEqual(data);
    expect(payload.rows).toBe(1);
    expect(payload.logs).toEqual(['ok']);
  });

  it('enforces the output row cap', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ i }));
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: rows })));
    const res = await tool.execute({ code: 'pd...', maxRows: 1500, context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toContain('2,000 rows');
    expect(res.error).toContain('max 1,500');
  });

  it('rejects traversal input paths before reading', async () => {
    const vault = makeVault();
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [] }), vault));
    const res = await tool.execute({ code: 'x', inputs: { evil: '../../secrets.csv' }, context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid input path/);
    expect((vault.adapter as { readBinary: jest.Mock }).readBinary).not.toHaveBeenCalled();
  });

  it('enforces the input size cap', async () => {
    const big = new Uint8Array(2 * 1024 * 1024).buffer; // 2MB
    const vault = makeVault({ adapter: { readBinary: jest.fn(async () => big), write: jest.fn() } });
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [] }), vault));
    const res = await tool.execute({
      code: 'x',
      inputs: { big: 'data/big.csv' },
      maxInputBytes: 1024 * 1024, // 1MB cap
      context: ctx,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/max 1\.0MB/);
  });

  it('injects inputs into the sandbox with a /data path and the var name', async () => {
    const sandbox = new FakeSandbox({ success: true, data: [{ ok: 1 }] });
    const tool = new RunPythonTool(makeAgent(sandbox));
    await tool.execute({ code: 'x', inputs: { budget: 'data/budget.csv' }, context: ctx });
    expect(sandbox.lastRequest?.files).toHaveLength(1);
    expect(sandbox.lastRequest?.files[0]).toMatchObject({
      varName: 'budget',
      sandboxPath: '/data/0_budget.csv',
    });
  });

  it('gives colliding var names distinct sandbox paths (no silent overwrite)', async () => {
    const sandbox = new FakeSandbox({ success: true, data: [{ ok: 1 }] });
    const tool = new RunPythonTool(makeAgent(sandbox));
    // "a b" and "a_b" both sanitize to "a_b" — index prefix must keep them apart
    await tool.execute({ code: 'x', inputs: { 'a b': 'x.csv', a_b: 'y.csv' }, context: ctx });
    const paths = sandbox.lastRequest?.files.map((f) => f.sandboxPath);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toEqual(['/data/0_a_b.csv', '/data/1_a_b.csv']);
  });

  it('enforces the output byte budget for non-array shapes (row-cap bypass closed)', async () => {
    const sneaky = { rows: Array.from({ length: 100 }, (_, i) => ({ i })) };
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: sneaky })));
    const res = await tool.execute({ code: 'x', maxOutputBytes: 50, context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/KB \(max/);
  });

  it('persists the result to outputPath when provided', async () => {
    const vault = makeVault();
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [{ a: 1 }] }), vault));
    const res = await tool.execute({ code: 'x', outputPath: 'reports/out.json', context: ctx });
    expect(res.success).toBe(true);
    expect((vault as { create: jest.Mock }).create).toHaveBeenCalledWith('reports/out.json', expect.stringContaining('"a": 1'));
    expect((res.data as { outputPath: string }).outputPath).toBe('reports/out.json');
  });

  it('rejects an invalid outputPath', async () => {
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: true, data: [] })));
    const res = await tool.execute({ code: 'x', outputPath: '../escape.json', context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid output path/);
  });

  it('surfaces a sandbox failure', async () => {
    const tool = new RunPythonTool(makeAgent(new FakeSandbox({ success: false, error: 'boom (traceback)' })));
    const res = await tool.execute({ code: 'x', context: ctx });
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom (traceback)');
  });
});
