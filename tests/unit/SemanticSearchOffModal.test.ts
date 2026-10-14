/**
 * The confirmation shown before semantic search is turned off.
 *
 * Failure this buys: turning search off used to save silently and ask for a
 * restart. Now it must ask first, with the agreed copy, and only "Turn off"
 * may resolve true: Cancel, the close button and Escape (both arrive as
 * close()) keep search on. The modal renders into FakeElement roots so the
 * copy, order and button styling are read from markup.
 */
import { App } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { SemanticSearchOffModal } from '../../src/settings/tabs/defaults/SemanticSearchOffModal';
import { SEMANTIC_OFF_MODAL_COPY as COPY } from '../../src/components/shared/chatSettings/copy';

function open(): { modal: SemanticSearchOffModal; resolved: jest.Mock; modalEl: FakeElement; contentEl: FakeElement; titleEl: FakeElement } {
  const resolved = jest.fn();
  const modal = new SemanticSearchOffModal(new App() as never, resolved);
  const modalEl = createFakeRoot();
  const contentEl = createFakeRoot();
  const titleEl = createFakeRoot();
  Object.assign(modal, { modalEl, contentEl, titleEl });
  modal.open();
  return { modal, resolved, modalEl, contentEl, titleEl };
}

function buttons(modalEl: FakeElement): FakeElement[] {
  return modalEl.querySelector('.modal-button-container')?.children ?? [];
}

it('says what turning search off does, with Cancel and a warning Turn off', () => {
  const { modalEl, contentEl, titleEl } = open();
  expect(titleEl.textContent).toBe(COPY.title);
  expect(modalEl.hasClass('mod-confirm')).toBe(true);
  expect(contentEl.children.map(child => child.tagName)).toEqual(['P', 'UL', 'P']);
  expect(contentEl.children[0].textContent).toBe(COPY.lede);
  expect(contentEl.children[1].children.map(item => item.textContent)).toEqual([...COPY.bullets]);
  expect(contentEl.children[2].textContent).toBe(COPY.note);
  const [cancel, turnOff] = buttons(modalEl);
  expect(cancel.textContent).toBe(COPY.cancel);
  expect(turnOff.textContent).toBe(COPY.confirm);
  expect(turnOff.hasClass('mod-warning')).toBe(true);
});

it('resolves true only for Turn off', () => {
  const { modalEl, resolved } = open();
  buttons(modalEl)[1].click();
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(resolved).toHaveBeenCalledWith(true);
});

it('resolves false for Cancel', () => {
  const { modalEl, resolved } = open();
  buttons(modalEl)[0].click();
  expect(resolved).toHaveBeenCalledWith(false);
});

it('resolves false, once, when closed by Escape or the close button', () => {
  const { modal, resolved } = open();
  modal.close();
  modal.close();
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(resolved).toHaveBeenCalledWith(false);
});
