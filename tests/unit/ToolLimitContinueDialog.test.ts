/**
 * A stopped or aborted tool run must not resume from a stale confirmation.
 * Exercise the real modal's choice and AbortSignal lifecycle.
 */
import { App, ButtonComponent, Modal } from 'obsidian';
import { ConfirmModal } from '../../src/settings/components/ConfirmModal';

function captureButtons(open: () => Promise<boolean>): {
  result: Promise<boolean>;
  buttons: Array<{ label: string; click: () => void }>;
  restore: () => void;
} {
  const buttons: Array<{ label: string; click: () => void }> = [];
  let label = '';
  const originalSetText = ButtonComponent.prototype.setButtonText;
  const originalOnClick = ButtonComponent.prototype.onClick;
  ButtonComponent.prototype.setButtonText = function (text: string) {
    label = text;
    return originalSetText.call(this, text);
  };
  ButtonComponent.prototype.onClick = function (callback: () => void) {
    buttons.push({ label, click: callback });
    return originalOnClick.call(this, callback);
  };

  try {
    const result = open();
    return {
      result,
      buttons,
      restore: () => {
        ButtonComponent.prototype.setButtonText = originalSetText;
        ButtonComponent.prototype.onClick = originalOnClick;
      }
    };
  } catch (error) {
    ButtonComponent.prototype.setButtonText = originalSetText;
    ButtonComponent.prototype.onClick = originalOnClick;
    throw error;
  }
}

describe('tool limit continuation dialog', () => {
  const app = new App();

  it('resolves Continue true and Stop false with friendly button labels', async () => {
    for (const [choice, expected] of [['Continue', true], ['Stop', false]] as const) {
      const capture = captureButtons(() => ConfirmModal.confirm(app, {
        variant: 'continue',
        title: 'Continue using tools?',
        body: 'The assistant has completed 25 tool calls. Continue to allow 25 more calls, or stop here.',
        cancelLabel: 'Stop'
      }));
      capture.restore();

      expect(capture.buttons.map(button => button.label)).toEqual(['Stop', 'Continue']);
      const button = capture.buttons.find(item => item.label === choice);
      expect(button).toBeDefined();
      button?.click();
      await expect(capture.result).resolves.toBe(expected);
    }
  });

  it('closes and resolves false if generation aborts while waiting', async () => {
    const controller = new AbortController();
    const close = jest.spyOn(Modal.prototype, 'close');
    const capture = captureButtons(() => ConfirmModal.confirm(app, {
      variant: 'continue',
      title: 'Continue using tools?',
      body: 'The assistant has completed 25 tool calls.',
      cancelLabel: 'Stop',
      abortSignal: controller.signal
    }));
    capture.restore();

    controller.abort();
    await expect(capture.result).resolves.toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('does not open a dialog for an already aborted generation', async () => {
    const controller = new AbortController();
    controller.abort();
    const capture = captureButtons(() => ConfirmModal.confirm(app, {
      variant: 'continue',
      title: 'Continue using tools?',
      body: 'The assistant has completed 25 tool calls.',
      abortSignal: controller.signal
    }));
    capture.restore();

    expect(capture.buttons).toHaveLength(0);
    await expect(capture.result).resolves.toBe(false);
  });
});
