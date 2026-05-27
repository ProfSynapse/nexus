/**
 * ConfirmModal A11y Characterization Tests
 *
 * Documents the current accessibility surface of ConfirmModal and flags
 * gaps that warrant a follow-up issue.
 *
 * What ConfirmModal DOES today (verified):
 *   - Extends Obsidian's Modal base class — inherits role="dialog" via
 *     Obsidian-managed modalEl (cannot be asserted directly in jsdom; this
 *     test asserts the structural primitives our code creates).
 *   - Creates an h2 title element inside contentEl.
 *   - Creates a p body element inside contentEl.
 *   - Variant-class added to contentEl for CSS targeting.
 *
 * What ConfirmModal does NOT do today (gap — flagged for follow-up):
 *   - Does NOT set aria-label / aria-labelledby on modalEl or contentEl
 *     (i.e., the title h2 has no id, so it cannot be referenced by aria
 *     attributes).
 *   - Does NOT set aria-describedby on the body p (so screen readers will
 *     reach the body text only via focus traversal, not via the dialog's
 *     accessible description).
 *
 * RECOMMENDATION (deferred to follow-up issue):
 *   In a future PR, ConfirmModal.onOpen should:
 *     1. Generate a stable id for the h2 (e.g., `nexus-confirm-title-${rand}`).
 *     2. Generate a stable id for the body p.
 *     3. Set this.titleEl.id / modalEl.setAttribute('aria-labelledby', titleId).
 *     4. Set modalEl.setAttribute('aria-describedby', bodyId).
 *   This is non-trivial because Obsidian's Modal already manages modalEl and
 *   we'd need to verify titleEl vs modalEl semantics. PR1 ships with the
 *   default Obsidian Modal a11y posture.
 */

import { App, ButtonComponent } from 'obsidian';
import { ConfirmModal } from '../../src/settings/components/ConfirmModal';

describe('ConfirmModal a11y characterization', () => {
  const app = {} as App;

  describe('Modal lifecycle inheritance', () => {
    it('extends Obsidian Modal (inherits role=dialog from base class)', () => {
      const modal = new ConfirmModal(app, {
        variant: 'delete',
        title: 'T',
        body: 'B',
        onConfirm: jest.fn()
      });

      // The Modal base class manages modalEl + role=dialog at runtime.
      // In our jsdom Obsidian mock, modalEl exists as a div placeholder.
      expect(modal.modalEl).toBeDefined();
      expect(modal.contentEl).toBeDefined();
      // titleEl is set up by Modal — currently unused by ConfirmModal's body.
      expect(modal.titleEl).toBeDefined();
    });
  });

  describe('Heading structure (assertive screen-reader anchor)', () => {
    it('emits h2 with config.title text inside contentEl on open', () => {
      const modal = new ConfirmModal(app, {
        variant: 'delete',
        title: 'Delete workspace?',
        body: 'B',
        onConfirm: jest.fn()
      });

      const createElSpy = jest.spyOn(modal.contentEl, 'createEl');
      modal.open();

      expect(createElSpy).toHaveBeenCalledWith('h2', { text: 'Delete workspace?' });
    });

    it('emits p with config.body text inside contentEl on open', () => {
      const modal = new ConfirmModal(app, {
        variant: 'remove',
        title: 'T',
        body: 'This action cannot be undone.',
        onConfirm: jest.fn()
      });

      const createElSpy = jest.spyOn(modal.contentEl, 'createEl');
      modal.open();

      expect(createElSpy).toHaveBeenCalledWith('p', { text: 'This action cannot be undone.' });
    });
  });

  describe('Documented a11y gap — flagged for follow-up issue', () => {
    /**
     * These assertions DOCUMENT the current state of the code so future
     * a11y improvements have a falsifiable baseline. When ConfirmModal
     * gains explicit aria-labelledby/aria-describedby wiring, these tests
     * should be FLIPPED to assert the positive behavior.
     */
    it('GAP: does not set an id on the title h2 (no aria-labelledby anchor)', () => {
      const modal = new ConfirmModal(app, {
        variant: 'archive',
        title: 'Archive state?',
        body: 'B',
        onConfirm: jest.fn()
      });

      const createElCalls: Array<{ tag: string; options?: { text?: string; attr?: Record<string, string> } }> = [];
      const origCreateEl = modal.contentEl.createEl.bind(modal.contentEl);
      modal.contentEl.createEl = jest.fn((tag: string, options?: { text?: string; attr?: Record<string, string> }) => {
        createElCalls.push({ tag, options });
        return origCreateEl(tag as never, options as never);
      }) as never;

      modal.open();

      const h2Call = createElCalls.find((c) => c.tag === 'h2');
      expect(h2Call).toBeDefined();
      // Document: no `attr: { id: ... }` is passed today.
      expect(h2Call?.options?.attr).toBeUndefined();
    });

    it('GAP: does not set an id on the body p (no aria-describedby anchor)', () => {
      const modal = new ConfirmModal(app, {
        variant: 'archive',
        title: 'T',
        body: 'This action is reversible.',
        onConfirm: jest.fn()
      });

      const createElCalls: Array<{ tag: string; options?: { text?: string; attr?: Record<string, string> } }> = [];
      const origCreateEl = modal.contentEl.createEl.bind(modal.contentEl);
      modal.contentEl.createEl = jest.fn((tag: string, options?: { text?: string; attr?: Record<string, string> }) => {
        createElCalls.push({ tag, options });
        return origCreateEl(tag as never, options as never);
      }) as never;

      modal.open();

      const pCall = createElCalls.find((c) => c.tag === 'p');
      expect(pCall).toBeDefined();
      // Document: no `attr: { id: ... }` is passed today.
      expect(pCall?.options?.attr).toBeUndefined();
    });
  });

  describe('Keyboard accessibility — Cancel button presence', () => {
    it('emits a Cancel ButtonComponent so users can dismiss without confirming', () => {
      const buttonLabels: string[] = [];
      const origSetButtonText = ButtonComponent.prototype.setButtonText;
      ButtonComponent.prototype.setButtonText = function (label: string) {
        buttonLabels.push(label);
        return origSetButtonText.call(this, label);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'delete',
          title: 'T',
          body: 'B',
          onConfirm: jest.fn()
        });
        modal.open();

        // Cancel is the first button registered (so it's reachable via Tab).
        expect(buttonLabels[0]).toBe('Cancel');
      } finally {
        ButtonComponent.prototype.setButtonText = origSetButtonText;
      }
    });
  });
});
