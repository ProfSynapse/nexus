/**
 * ConfirmModal Unit Tests
 *
 * Verifies variant-aware copy emission, default CTA labels per variant,
 * onConfirm callback wiring, and Modal lifecycle compliance.
 */

import { ConfirmModal } from '../../src/settings/components/ConfirmModal';
import { App, ButtonComponent } from 'obsidian';

describe('ConfirmModal', () => {
  const app = {} as App;

  describe('variant copy + structure', () => {
    it('should emit h2 + p with config title + body when opened', () => {
      const modal = new ConfirmModal(app, {
        variant: 'delete',
        title: 'Delete workspace?',
        body: 'Delete workspace "Demo"? This cannot be undone.',
        onConfirm: jest.fn()
      });

      const createElSpy = jest.spyOn(modal.contentEl, 'createEl');
      modal.open();

      expect(createElSpy).toHaveBeenCalledWith('h2', { text: 'Delete workspace?' });
      expect(createElSpy).toHaveBeenCalledWith('p', { text: 'Delete workspace "Demo"? This cannot be undone.' });
    });

    it('should add nexus-confirm-modal and variant class to contentEl', () => {
      const modal = new ConfirmModal(app, {
        variant: 'archive',
        title: 'Archive state?',
        body: 'Archive state "Snapshot 1"?',
        onConfirm: jest.fn()
      });

      const addClassSpy = jest.spyOn(modal.contentEl, 'addClass');
      modal.open();

      expect(addClassSpy).toHaveBeenCalledWith('nexus-confirm-modal');
      expect(addClassSpy).toHaveBeenCalledWith('nexus-confirm-modal--archive');
    });
  });

  describe('default CTA labels per variant', () => {
    it.each<['delete' | 'remove' | 'archive', string]>([
      ['delete', 'Delete'],
      ['remove', 'Remove'],
      ['archive', 'Archive'],
    ])('variant=%s should default CTA label to %s', (variant, expectedLabel) => {
      const setButtonTextCalls: string[] = [];
      const origSetButtonText = ButtonComponent.prototype.setButtonText;
      ButtonComponent.prototype.setButtonText = function (label: string) {
        setButtonTextCalls.push(label);
        return origSetButtonText.call(this, label);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant,
          title: 'Title',
          body: 'Body',
          onConfirm: jest.fn()
        });
        modal.open();

        expect(setButtonTextCalls).toContain(expectedLabel);
      } finally {
        ButtonComponent.prototype.setButtonText = origSetButtonText;
      }
    });
  });

  describe('CTA wiring', () => {
    it('should call onConfirm when CTA is clicked', () => {
      const onConfirm = jest.fn();
      const modal = new ConfirmModal(app, {
        variant: 'delete',
        title: 'Delete?',
        body: 'Confirm?',
        onConfirm
      });

      // Spy on ButtonComponent.onClick BEFORE open
      const onClickCalls: Array<() => void> = [];
      const origOnClick = ButtonComponent.prototype.onClick;
      ButtonComponent.prototype.onClick = function (cb: () => void) {
        onClickCalls.push(cb);
        return origOnClick.call(this, cb);
      };

      try {
        modal.open();

        // 2 ButtonComponents constructed inside ConfirmModal.onOpen:
        // [0] Cancel, [1] CTA
        expect(onClickCalls.length).toBeGreaterThanOrEqual(2);
        const ctaCb = onClickCalls[onClickCalls.length - 1];
        if (ctaCb) ctaCb();

        // onConfirm is invoked synchronously; modal.close() runs after.
        expect(onConfirm).toHaveBeenCalledTimes(1);
      } finally {
        ButtonComponent.prototype.onClick = origOnClick;
      }
    });

    it('should NOT call onConfirm when Cancel is clicked', () => {
      const onConfirm = jest.fn();
      const modal = new ConfirmModal(app, {
        variant: 'delete',
        title: 'Delete?',
        body: 'Confirm?',
        onConfirm
      });

      const onClickCalls: Array<() => void> = [];
      const origOnClick = ButtonComponent.prototype.onClick;
      ButtonComponent.prototype.onClick = function (cb: () => void) {
        onClickCalls.push(cb);
        return origOnClick.call(this, cb);
      };

      try {
        modal.open();
        // Click Cancel (first button registered)
        const cancelCb = onClickCalls[0];
        if (cancelCb) cancelCb();

        expect(onConfirm).not.toHaveBeenCalled();
      } finally {
        ButtonComponent.prototype.onClick = origOnClick;
      }
    });
  });

  describe('CTA styling per variant', () => {
    it('delete variant should call setWarning on CTA', () => {
      const setWarningCalls: number[] = [];
      const origSetWarning = ButtonComponent.prototype.setWarning;
      ButtonComponent.prototype.setWarning = function () {
        setWarningCalls.push(1);
        return origSetWarning.call(this);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'delete',
          title: 'Delete?',
          body: 'Confirm?',
          onConfirm: jest.fn()
        });
        modal.open();

        expect(setWarningCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        ButtonComponent.prototype.setWarning = origSetWarning;
      }
    });

    it('remove variant should call setWarning on CTA', () => {
      const setWarningCalls: number[] = [];
      const origSetWarning = ButtonComponent.prototype.setWarning;
      ButtonComponent.prototype.setWarning = function () {
        setWarningCalls.push(1);
        return origSetWarning.call(this);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'remove',
          title: 'Remove?',
          body: 'Confirm?',
          onConfirm: jest.fn()
        });
        modal.open();

        expect(setWarningCalls.length).toBeGreaterThanOrEqual(1);
      } finally {
        ButtonComponent.prototype.setWarning = origSetWarning;
      }
    });

    it('archive variant should call setCta on CTA (not setWarning)', () => {
      const setCtaCalls: number[] = [];
      const setWarningCalls: number[] = [];
      const origSetCta = ButtonComponent.prototype.setCta;
      const origSetWarning = ButtonComponent.prototype.setWarning;
      ButtonComponent.prototype.setCta = function () {
        setCtaCalls.push(1);
        return origSetCta.call(this);
      };
      ButtonComponent.prototype.setWarning = function () {
        setWarningCalls.push(1);
        return origSetWarning.call(this);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'archive',
          title: 'Archive?',
          body: 'Confirm?',
          onConfirm: jest.fn()
        });
        modal.open();

        expect(setCtaCalls.length).toBeGreaterThanOrEqual(1);
        expect(setWarningCalls.length).toBe(0);
      } finally {
        ButtonComponent.prototype.setCta = origSetCta;
        ButtonComponent.prototype.setWarning = origSetWarning;
      }
    });
  });

  describe('CTA label override', () => {
    it('should honor ctaLabel override when provided', () => {
      const setButtonTextCalls: string[] = [];
      const origSetButtonText = ButtonComponent.prototype.setButtonText;
      ButtonComponent.prototype.setButtonText = function (label: string) {
        setButtonTextCalls.push(label);
        return origSetButtonText.call(this, label);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'delete',
          title: 'Custom?',
          body: 'Confirm?',
          ctaLabel: 'Yes, delete it',
          onConfirm: jest.fn()
        });
        modal.open();

        // Should include the override label
        expect(setButtonTextCalls).toContain('Yes, delete it');
        // Should NOT include the default 'Delete' label
        expect(setButtonTextCalls).not.toContain('Delete');
      } finally {
        ButtonComponent.prototype.setButtonText = origSetButtonText;
      }
    });

    it('should use default label when ctaLabel omitted', () => {
      const setButtonTextCalls: string[] = [];
      const origSetButtonText = ButtonComponent.prototype.setButtonText;
      ButtonComponent.prototype.setButtonText = function (label: string) {
        setButtonTextCalls.push(label);
        return origSetButtonText.call(this, label);
      };

      try {
        const modal = new ConfirmModal(app, {
          variant: 'archive',
          title: 'Archive?',
          body: 'Confirm?',
          onConfirm: jest.fn()
        });
        modal.open();

        expect(setButtonTextCalls).toContain('Archive');
      } finally {
        ButtonComponent.prototype.setButtonText = origSetButtonText;
      }
    });
  });
});
