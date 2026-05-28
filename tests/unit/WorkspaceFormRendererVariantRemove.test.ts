/**
 * WorkspaceFormRenderer — variant=remove Wiring Coverage (C-7)
 *
 * Asserts that the workflow-× and keyfile-× buttons in WorkspaceFormRenderer
 * (PR2 Group B) route through `ConfirmModal.confirm(app, { variant: 'remove' })`
 * and that the splice + UI refresh occurs ONLY when the user confirms.
 *
 * Strategy: jest.mock the ConfirmModal module so its `confirm()` static
 * captures (app, config) + a manually-resolvable resolver. Then drive the
 * × handlers via ButtonComponent.onClick prototype-patch capture and resolve
 * each captured ConfirmModal call deterministically.
 */

import { App, ButtonComponent, Component, createMockElement } from 'obsidian';

interface CapturedConfirmCall {
  app: unknown;
  config: {
    variant: 'delete' | 'remove' | 'archive';
    title: string;
    body: string;
    ctaLabel?: string;
    onConfirm?: () => void | Promise<void>;
  };
  resolve: (value: boolean) => void;
}

const capturedInstances: CapturedConfirmCall[] = [];

jest.mock('../../src/settings/components/ConfirmModal', () => ({
  ConfirmModal: {
    confirm: jest.fn().mockImplementation((app: unknown, config: CapturedConfirmCall['config']) => {
      return new Promise<boolean>((resolve) => {
        // Wrap resolve so we also flush the onConfirm side-effect synchronously
        // when the user confirms — mirrors ConfirmModal.onOpen's CTA chain
        // (Promise.resolve(onConfirm()).then(...).finally(close→onResolve)).
        capturedInstances.push({
          app,
          config,
          resolve: (val: boolean) => {
            if (val && config.onConfirm) {
              void Promise.resolve(config.onConfirm()).then(() => resolve(true), () => resolve(false));
            } else {
              resolve(val);
            }
          }
        });
      });
    })
  }
}));

import { WorkspaceFormRenderer } from '../../src/components/workspace/WorkspaceFormRenderer';
import type { ProjectWorkspace } from '../../src/database/workspace-types';

/**
 * Capture every ButtonComponent.onClick callback wired during a render pass,
 * preserving order so we can map by index to the action button we care about.
 * Each handler records its `setButtonText` label so we can find × by text.
 */
function captureButtonClicks(action: () => void): Array<{ label: string; handler: () => void | Promise<void> }> {
  const handlers: Array<{ label: string; handler: () => void | Promise<void> }> = [];
  const lastLabel = { value: '' };
  const originalSetText = ButtonComponent.prototype.setButtonText;
  const originalOnClick = ButtonComponent.prototype.onClick;

  ButtonComponent.prototype.setButtonText = function (this: ButtonComponent, text: string) {
    lastLabel.value = text;
    return originalSetText.call(this, text);
  };
  ButtonComponent.prototype.onClick = function (this: ButtonComponent, callback: () => void) {
    handlers.push({ label: lastLabel.value, handler: callback });
    return originalOnClick.call(this, callback);
  };

  try {
    action();
  } finally {
    ButtonComponent.prototype.setButtonText = originalSetText;
    ButtonComponent.prototype.onClick = originalOnClick;
  }
  return handlers;
}

function makeFormData(): Partial<ProjectWorkspace> {
  return {
    id: 'ws-1',
    name: 'Test workspace',
    description: '',
    rootFolder: '/',
    context: {
      purpose: '',
      workflows: [
        { name: 'Daily review', when: 'morning', promptName: 'review' },
        { name: 'Weekly summary', when: 'friday', promptName: 'summary' }
      ],
      keyFiles: ['notes/index.md', 'notes/scratch.md'],
      preferences: ''
    }
  } as Partial<ProjectWorkspace>;
}

/**
 * Resolution helper for the index-vs-content mismatch:
 * `captureButtonClicks` tags each handler with the most-recently-set
 * `setButtonText` label, but some buttons (e.g., the workflow Run button)
 * use `setIcon` only and inherit a stale "×" label from the prior button.
 * To find a × handler whose ConfirmModal *capture* matches the expected
 * title, drive each candidate and inspect the resulting capture.
 *
 * Returns the capture (after the handler ran). Pass it to .resolve() to
 * complete the flow.
 */
async function triggerRemoveByTitle(
  handlers: Array<{ label: string; handler: () => void | Promise<void> }>,
  expectedTitle: string
): Promise<CapturedConfirmCall> {
  const xHandlers = handlers.filter(h => h.label === '×');
  for (const h of xHandlers) {
    const before = capturedInstances.length;
    void h.handler();
    await Promise.resolve();
    if (capturedInstances.length > before) {
      const inst = capturedInstances[capturedInstances.length - 1];
      if (inst.config.title === expectedTitle) {
        return inst;
      }
      // Drain non-matching capture without firing onConfirm.
      inst.resolve(false);
    }
  }
  throw new Error(`No '×' handler produced a ConfirmModal with title "${expectedTitle}". Captured titles: ${capturedInstances.map(i => i.config.title).join(', ')}`);
}

describe('WorkspaceFormRenderer — variant=remove × wiring (C-7)', () => {
  beforeEach(() => {
    capturedInstances.length = 0;
  });

  describe('workflow × button', () => {
    it('opens ConfirmModal with variant=remove + workflow-specific copy', async () => {
      const app = new App();
      const formData = makeFormData();
      const onRefresh = jest.fn();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        onRefresh,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));
      // Order-independent: key files now render before workflows in the
      // consolidated Context section, so match the × handler by ConfirmModal title.
      const inst = await triggerRemoveByTitle(handlers, 'Remove workflow');

      expect(inst.config.variant).toBe('remove');
      expect(inst.config.title).toBe('Remove workflow');
      expect(inst.config.body).toContain('Remove this workflow');
      expect(inst.config.ctaLabel).toBe('Remove');

      // Resolve to avoid dangling promise.
      inst.resolve(false);
    });

    it('splices the workflow from the array AND calls onRefresh when user confirms', async () => {
      const app = new App();
      const formData = makeFormData();
      const onRefresh = jest.fn();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        onRefresh,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));

      expect(formData.context!.workflows).toHaveLength(2);

      // Match workflow row 0's × by ConfirmModal title (order-independent).
      const inst = await triggerRemoveByTitle(handlers, 'Remove workflow');
      // Resolve TRUE to fire onConfirm → splice + onRefresh.
      inst.resolve(true);
      await Promise.resolve();

      expect(formData.context!.workflows).toHaveLength(1);
      expect(formData.context!.workflows![0].name).toBe('Weekly summary');
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('does NOT splice or call onRefresh when user cancels', async () => {
      const app = new App();
      const formData = makeFormData();
      const onRefresh = jest.fn();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        onRefresh,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));

      const inst = await triggerRemoveByTitle(handlers, 'Remove workflow');
      inst.resolve(false);
      await Promise.resolve();

      expect(formData.context!.workflows).toHaveLength(2);
      expect(onRefresh).not.toHaveBeenCalled();
    });
  });

  describe('keyfile × button', () => {
    it('opens ConfirmModal with variant=remove + key-file-specific copy', async () => {
      const app = new App();
      const formData = makeFormData();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));
      const inst = await triggerRemoveByTitle(handlers, 'Remove key file');

      expect(inst.config.variant).toBe('remove');
      expect(inst.config.title).toBe('Remove key file');
      expect(inst.config.body).toContain('Remove this key file');
      expect(inst.config.ctaLabel).toBe('Remove');

      inst.resolve(false);
    });

    it('splices the keyfile from the array when user confirms (in-place update via updateKeyFilesList)', async () => {
      const app = new App();
      const formData = makeFormData();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));

      expect(formData.context!.keyFiles).toEqual(['notes/index.md', 'notes/scratch.md']);

      const inst = await triggerRemoveByTitle(handlers, 'Remove key file');
      inst.resolve(true);
      // Yield for the onConfirm Promise chain.
      await Promise.resolve();
      await Promise.resolve();

      expect(formData.context!.keyFiles).toEqual(['notes/scratch.md']);
    });

    it('does NOT splice when user cancels keyfile remove', async () => {
      const app = new App();
      const formData = makeFormData();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));
      const inst = await triggerRemoveByTitle(handlers, 'Remove key file');
      inst.resolve(false);
      await Promise.resolve();

      expect(formData.context!.keyFiles).toEqual(['notes/index.md', 'notes/scratch.md']);
    });
  });

  describe('cross-site — both × call sites use variant=remove uniformly', () => {
    it('every × handler that opens a ConfirmModal uses variant=remove (workflow + keyfile)', async () => {
      const app = new App();
      const formData = makeFormData();
      const renderer = new WorkspaceFormRenderer(
        formData,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        app
      );
      const container = createMockElement('div');

      const handlers = captureButtonClicks(() => renderer.render(container));
      const xHandlers = handlers.filter(h => h.label === '×');

      // Drive each × handler and observe its ConfirmModal capture (if any).
      // Note: `captureButtonClicks` may tag some handlers as '×' due to
      // stale-label inheritance (e.g., setIcon + onClick without setButtonText).
      // We don't care about that — we only require that EVERY ConfirmModal
      // capture produced by these handlers uses variant=remove.
      for (const h of xHandlers) {
        const before = capturedInstances.length;
        void h.handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          expect(inst.config.variant).toBe('remove');
          inst.resolve(false);
          await Promise.resolve();
        }
      }

      // Sanity: at least the 4 expected calls (2 workflow + 2 keyfile)
      // surfaced ConfirmModal captures with variant=remove.
      const removeCaptures = capturedInstances.filter(i => i.config.variant === 'remove');
      expect(removeCaptures.length).toBeGreaterThanOrEqual(4);
    });
  });
});
