/**
 * SkillsSectionRenderer Unit Tests
 *
 * Mirrors the StatesSectionRendererPort test pattern: drives the renderer's
 * service-delegation contract directly rather than asserting DOM-tree shape
 * (the Obsidian mock's createEl/createDiv don't track children).
 *
 * Coverage:
 *   - render() smoke: scan → syncFromScan → list(includeArchived=false), and
 *     a friendly error when the runtime isn't ready.
 *   - Delete-confirm wiring: ConfirmModal accept → write.removeTree +
 *     index.hardDelete; cancel → neither called. ConfirmModal is mocked with a
 *     spy-class so we can drive the confirm flow synthetically.
 */

import { App, Component, createMockElement } from 'obsidian';

// --- Mock ConfirmModal.confirm() so we can drive the confirm flow. -----------
interface CapturedConfirmCall {
  app: unknown;
  config: { variant: string; title: string; body: string };
  resolve: (value: boolean) => void;
}
const capturedConfirms: CapturedConfirmCall[] = [];

jest.mock('../../src/settings/components/ConfirmModal', () => ({
  ConfirmModal: {
    confirm: jest.fn().mockImplementation((app: unknown, config: CapturedConfirmCall['config']) => {
      return new Promise<boolean>((resolve) => {
        capturedConfirms.push({ app, config, resolve });
      });
    })
  }
}));

// --- Mock resolveSkillsRuntime so we inject fake services. -------------------
import type { SkillRecord } from '../../src/agents/apps/skills/types';

type FakeIndex = {
  syncFromScan: jest.Mock;
  list: jest.Mock;
  setArchived: jest.Mock;
  hardDelete: jest.Mock;
  upsertOne: jest.Mock;
};
type FakeScanner = { scan: jest.Mock };
type FakeWrite = { removeTree: jest.Mock; exists: jest.Mock; readSkillMd: jest.Mock };

let fakeIndex: FakeIndex;
let fakeScanner: FakeScanner;
let resolveOk = true;

jest.mock('../../src/agents/apps/skills/services/SkillsContext', () => ({
  resolveSkillsRuntime: jest.fn().mockImplementation(() => {
    if (!resolveOk) {
      return { ok: false, error: 'Storage is still initializing' };
    }
    return {
      ok: true,
      rt: {
        skillsRoot: 'Nexus/skills',
        vaultAdapter: {},
        index: fakeIndex,
        scanner: fakeScanner,
        sqlite: {},
      }
    };
  })
}));

// SkillWriteService / SkillSyncService are constructed inside the renderer with
// `new`; mock the modules so those constructors return our fakes.
const fakeWrite: FakeWrite = {
  removeTree: jest.fn().mockResolvedValue(undefined),
  exists: jest.fn().mockResolvedValue(false),
  readSkillMd: jest.fn().mockResolvedValue(null),
};
jest.mock('../../src/agents/apps/skills/services/SkillWriteService', () => ({
  SkillWriteService: jest.fn().mockImplementation(() => fakeWrite)
}));
jest.mock('../../src/agents/apps/skills/services/SkillSyncService', () => ({
  SkillSyncService: jest.fn().mockImplementation(() => ({
    discoverProviders: jest.fn().mockResolvedValue([]),
    import: jest.fn().mockResolvedValue({ imported: [], skipped: [], archived: [] }),
    syncBack: jest.fn().mockResolvedValue({ syncedBack: [], skipped: [], archived: [] }),
  }))
}));

import { SkillsSectionRenderer } from '../../src/components/skills/SkillsSectionRenderer';
import type { SkillsAgent } from '../../src/agents/apps/skills/SkillsAgent';

interface TestableRenderer {
  bundle: unknown;
  includeArchived: boolean;
  cachedSkills: SkillRecord[];
  listContainer?: HTMLElement;
  loadAndRender(): Promise<void>;
  confirmAndDelete(skill: SkillRecord, btn: HTMLButtonElement): Promise<void>;
}

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'skill-1',
    provider: 'nexus',
    name: 'essay-editor',
    description: 'Edit essays.',
    vaultPath: 'Nexus/skills/nexus/essay-editor',
    contentHash: 'abc',
    isArchived: false,
    created: 1,
    updated: 2,
    ...overrides,
  };
}

const fakeAgent = {} as unknown as SkillsAgent;

describe('SkillsSectionRenderer', () => {
  beforeEach(() => {
    capturedConfirms.length = 0;
    resolveOk = true;
    fakeIndex = {
      syncFromScan: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue([]),
      setArchived: jest.fn().mockResolvedValue(null),
      hardDelete: jest.fn().mockResolvedValue(undefined),
      upsertOne: jest.fn().mockResolvedValue(undefined),
    };
    fakeScanner = { scan: jest.fn().mockResolvedValue([]) };
    fakeWrite.removeTree.mockClear();
    fakeWrite.exists.mockClear();
    fakeWrite.readSkillMd.mockClear();
  });

  describe('render() smoke', () => {
    it('scans, syncs the index, and lists with includeArchived=false', async () => {
      const renderer = new SkillsSectionRenderer(new App(), createMockElement('div'), fakeAgent);
      await renderer.render();

      expect(fakeScanner.scan).toHaveBeenCalled();
      expect(fakeIndex.syncFromScan).toHaveBeenCalled();
      expect(fakeIndex.list).toHaveBeenCalledWith({ includeArchived: false });
    });

    it('caches the listed skills returned by the index', async () => {
      const skill = makeSkill();
      fakeIndex.list.mockResolvedValue([skill]);
      const renderer = new SkillsSectionRenderer(new App(), createMockElement('div'), fakeAgent) as unknown as TestableRenderer;
      await (renderer as unknown as SkillsSectionRenderer).render();
      expect(renderer.cachedSkills).toHaveLength(1);
      expect(renderer.cachedSkills[0].name).toBe('essay-editor');
    });

    it('renders a friendly notice and skips loading when the runtime is not ready', async () => {
      resolveOk = false;
      const renderer = new SkillsSectionRenderer(new App(), createMockElement('div'), fakeAgent);
      await renderer.render();
      expect(fakeScanner.scan).not.toHaveBeenCalled();
      expect(fakeIndex.list).not.toHaveBeenCalled();
    });
  });

  describe('delete flow — ConfirmModal accept → removeTree + hardDelete', () => {
    async function setupRenderer(): Promise<TestableRenderer> {
      const renderer = new SkillsSectionRenderer(new App(), createMockElement('div'), fakeAgent);
      await renderer.render();
      return renderer as unknown as TestableRenderer;
    }

    it('removes the tree then hard-deletes the index row after the user confirms', async () => {
      const renderer = await setupRenderer();
      const skill = makeSkill();
      const btn = createMockElement('button') as HTMLButtonElement;

      const pending = renderer.confirmAndDelete(skill, btn);
      await Promise.resolve();

      expect(capturedConfirms).toHaveLength(1);
      expect(capturedConfirms[0].config.variant).toBe('delete');
      capturedConfirms[0].resolve(true);
      await pending;

      expect(fakeWrite.removeTree).toHaveBeenCalledWith('Nexus/skills/nexus/essay-editor');
      expect(fakeIndex.hardDelete).toHaveBeenCalledWith('nexus', 'essay-editor');
    });

    it('removeTree runs before hardDelete (folder gone before index row)', async () => {
      const renderer = await setupRenderer();
      const order: string[] = [];
      fakeWrite.removeTree.mockImplementation(async () => { order.push('removeTree'); });
      fakeIndex.hardDelete.mockImplementation(async () => { order.push('hardDelete'); });

      const btn = createMockElement('button') as HTMLButtonElement;
      const pending = renderer.confirmAndDelete(makeSkill(), btn);
      await Promise.resolve();
      capturedConfirms[0].resolve(true);
      await pending;

      expect(order).toEqual(['removeTree', 'hardDelete']);
    });

    it('does NOT delete when the user cancels the confirm', async () => {
      const renderer = await setupRenderer();
      const btn = createMockElement('button') as HTMLButtonElement;

      const pending = renderer.confirmAndDelete(makeSkill(), btn);
      await Promise.resolve();
      capturedConfirms[0].resolve(false);
      await pending;

      expect(fakeWrite.removeTree).not.toHaveBeenCalled();
      expect(fakeIndex.hardDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete a skill whose vaultPath escapes the skills root (no confirm, no removeTree)', async () => {
      const renderer = await setupRenderer();
      const poisoned = makeSkill({ vaultPath: 'Nexus/skills/../../../.obsidian' });
      const btn = createMockElement('button') as HTMLButtonElement;

      await renderer.confirmAndDelete(poisoned, btn);

      // Bailed out BEFORE prompting and BEFORE any destructive call.
      expect(capturedConfirms).toHaveLength(0);
      expect(fakeWrite.removeTree).not.toHaveBeenCalled();
      expect(fakeIndex.hardDelete).not.toHaveBeenCalled();
    });
  });
});
