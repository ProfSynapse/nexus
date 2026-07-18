/**
 * Regression tests: the canvasManager write boundary confines caller paths to
 * the vault. `../` and absolute paths must be rejected WITHOUT any vault write.
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { TFile } from 'obsidian';
import { CanvasOperations } from '@/agents/canvasManager/utils/CanvasOperations';
import { WriteCanvasTool } from '@/agents/canvasManager/tools/write';
import { UpdateCanvasTool } from '@/agents/canvasManager/tools/update';

const ESCAPING = ['../../../../tmp/ESCAPE', '/tmp/ESCAPE', '~/ESCAPE'];
const emptyCanvas = { nodes: [], edges: [] };

interface MockVault {
  create: jest.Mock;
  modify: jest.Mock;
  createFolder: jest.Mock;
  read: jest.Mock;
  getAbstractFileByPath: jest.Mock;
}

function makeApp(existing?: TFile): { app: any; vault: MockVault } {
  const vault: MockVault = {
    create: jest.fn().mockResolvedValue(new TFile()),
    modify: jest.fn().mockResolvedValue(undefined),
    createFolder: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue(JSON.stringify(emptyCanvas)),
    getAbstractFileByPath: jest.fn().mockReturnValue(existing),
  };
  return { app: { vault }, vault };
}

describe('CanvasOperations.writeCanvas confinement', () => {
  it.each(ESCAPING)('throws for escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    await expect(CanvasOperations.writeCanvas(app, path, emptyCanvas)).rejects.toThrow();
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('creates a normal canvas (adds .canvas extension)', async () => {
    const { app, vault } = makeApp();
    await CanvasOperations.writeCanvas(app, 'diagrams/a', emptyCanvas);
    expect(vault.create).toHaveBeenCalledWith('diagrams/a.canvas', expect.any(String));
  });
});

describe('CanvasOperations.updateCanvas confinement', () => {
  it.each(ESCAPING)('throws for escaping path %s with no modify', async (path) => {
    const { app, vault } = makeApp();
    await expect(CanvasOperations.updateCanvas(app, path, emptyCanvas)).rejects.toThrow();
    expect(vault.modify).not.toHaveBeenCalled();
  });
});

describe('WriteCanvasTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    const result = await new WriteCanvasTool(app).execute({ path, nodes: [], edges: [] } as any);
    expect(result.success).toBe(false);
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('creates a normal canvas', async () => {
    const { app, vault } = makeApp();
    const result = await new WriteCanvasTool(app).execute({ path: 'diagrams/a', nodes: [], edges: [] } as any);
    expect(result.success).toBe(true);
    expect(vault.create).toHaveBeenCalledWith('diagrams/a.canvas', expect.any(String));
  });
});

describe('UpdateCanvasTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no modify', async (path) => {
    const file = new TFile('a.canvas', 'diagrams/a.canvas');
    const { app, vault } = makeApp(file);
    const result = await new UpdateCanvasTool(app).execute({ path, nodes: [], edges: [] } as any);
    expect(result.success).toBe(false);
    expect(vault.modify).not.toHaveBeenCalled();
  });
});
