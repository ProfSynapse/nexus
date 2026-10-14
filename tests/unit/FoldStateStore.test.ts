/**
 * Fold open/closed memory is device-local (app local storage), never data.json:
 * a synced key would make every other device treat a fold toggle as a settings
 * change that needs a reload.
 */
import { FOLD_STATE_STORAGE_KEY, FoldStateStore } from '../../src/components/shared/settings/FoldStateStore';
import { localStorageApp } from '../helpers/settingsDom';

it('round-trips open folds separately for each surface', () => {
  const app = localStorageApp();
  const store = new FoldStateStore(app);
  store.setOpen('defaults', 'context', true);
  store.setOpen('chat', 'voice', true);

  const reopened = new FoldStateStore(app);
  expect(reopened.isOpen('defaults', 'context')).toBe(true);
  expect(reopened.isOpen('chat', 'context')).toBe(false);
  expect(reopened.isOpen('chat', 'voice')).toBe(true);
  expect(app.store.get(FOLD_STATE_STORAGE_KEY)).toEqual({ v: 1, defaults: ['context'], chat: ['voice'] });

  reopened.setOpen('defaults', 'context', false);
  expect(new FoldStateStore(app).isOpen('defaults', 'context')).toBe(false);
});

it('does not duplicate an id opened twice', () => {
  const app = localStorageApp();
  const store = new FoldStateStore(app);
  store.setOpen('defaults', 'images', true);
  store.setOpen('defaults', 'images', true);
  expect(app.store.get(FOLD_STATE_STORAGE_KEY)).toEqual({ v: 1, defaults: ['images'], chat: [] });
});

it.each([
  ['malformed JSON', '{not json'],
  ['a wrong version', { v: 2, defaults: ['context'], chat: [] }],
  ['non-array lists', { v: 1, defaults: 'context', chat: 7 }],
  ['a number', 42]
])('treats %s as everything closed', (_label, stored) => {
  const store = new FoldStateStore(localStorageApp({ [FOLD_STATE_STORAGE_KEY]: stored }));
  expect(store.isOpen('defaults', 'context')).toBe(false);
  expect(store.isOpen('chat', 'context')).toBe(false);
});

it('ignores non-string entries but keeps the valid ones', () => {
  const store = new FoldStateStore(localStorageApp({ [FOLD_STATE_STORAGE_KEY]: { v: 1, defaults: ['context', 3, null], chat: [] } }));
  expect(store.isOpen('defaults', 'context')).toBe(true);
});

it('never touches plugin settings', () => {
  const app = localStorageApp();
  const saveSettings = jest.fn();
  const store = new FoldStateStore(app);
  store.setOpen('defaults', 'context', true);
  expect(saveSettings).not.toHaveBeenCalled();
  expect(app.saveLocalStorage).toHaveBeenCalledWith(FOLD_STATE_STORAGE_KEY, expect.anything());
});

it('survives an app without local storage and a throwing save', () => {
  expect(new FoldStateStore({}).isOpen('chat', 'context')).toBe(false);
  const store = new FoldStateStore({
    loadLocalStorage: () => null,
    saveLocalStorage: () => { throw new Error('quota'); }
  });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(() => store.setOpen('chat', 'context', true)).not.toThrow();
  } finally {
    warn.mockRestore();
  }
});
