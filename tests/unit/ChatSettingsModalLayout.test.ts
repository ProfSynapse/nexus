/**
 * Chat settings is a standard Obsidian modal: the title through setTitle, the
 * form in the content, and Cancel / Save in a bottom button container.
 *
 * Failure this buys: the modal drew its own header (an h2 plus a button row
 * above the form), so the buttons scrolled away with long settings and the
 * close button and title did not match other Obsidian modals.
 */
import { App } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { ChatSettingsModal } from '../../src/ui/chat/components/ChatSettingsModal';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { ModelAgentManager } from '../../src/ui/chat/services/ModelAgentManager';

jest.mock('../../src/utils/pluginLocator', () => ({ getNexusPlugin: jest.fn(() => null) }));

function openModal() {
  const modal = new ChatSettingsModal(new App(), null, {} as WorkspaceService, {} as ModelAgentManager);
  const view = modal as unknown as { contentEl: FakeElement; modalEl: FakeElement };
  view.modalEl = createFakeRoot();
  view.contentEl = view.modalEl.createDiv({ cls: 'modal-content' });
  const setTitle = jest.spyOn(modal, 'setTitle');
  modal.onOpen();
  return { modal, setTitle, ...view };
}

it('uses the modal title and puts Cancel and Save below the form', async () => {
  const { setTitle, contentEl, modalEl, modal } = openModal();
  await Promise.resolve();
  expect(setTitle).toHaveBeenCalledWith('Chat settings');
  expect(contentEl.querySelector('h2')).toBeNull();
  expect(contentEl.children[0].hasClass('chat-settings-renderer')).toBe(true);
  const buttons = modalEl.children[modalEl.children.length - 1];
  expect(buttons.hasClass('modal-button-container')).toBe(true);
  expect(buttons.querySelectorAll('button').map(button => button.textContent)).toEqual(['Cancel', 'Save']);
  expect(buttons.querySelector('button.mod-cta')?.textContent).toBe('Save');
  expect(buttons.querySelector('[role="status"]')).not.toBeNull();
  modal.onClose();
  expect(modalEl.querySelector('.modal-button-container')).toBeNull();
});

it('does not stack button rows when reopened', () => {
  const { modal, modalEl } = openModal();
  modal.onOpen();
  expect(modalEl.querySelectorAll('.modal-button-container')).toHaveLength(1);
});
