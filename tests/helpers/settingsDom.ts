/**
 * Helpers for reading the settings layout out of a FakeElement tree
 * (tests/mocks/obsidian/dom.ts). Everything here reads the rendered markup —
 * class names, attributes and text — never renderer internals.
 */
import { FakeElement } from '../mocks/obsidian/dom';

/** Direct `.setting-item` rows of a `setting-items` list, in order. */
export function rowsOf(itemsEl: FakeElement): FakeElement[] {
  return itemsEl.children.filter(child => child.hasClass('setting-item'));
}

export function rowName(row: FakeElement): string {
  return row.querySelector('.setting-item-name')?.textContent ?? '';
}

export function rowDesc(row: FakeElement): string {
  return row.querySelector('.setting-item-description')?.textContent ?? '';
}

export function rowNames(itemsEl: FakeElement): string[] {
  return rowsOf(itemsEl).map(rowName);
}

/** The heading-less top SettingGroup's list. */
export function topItems(container: FakeElement): FakeElement {
  const group = container.children.find(child => child.hasClass('setting-group'));
  const items = group?.querySelector('.setting-items');
  if (!items) throw new Error('No top setting group');
  return items;
}

export function accordions(container: FakeElement): FakeElement[] {
  return container.children.filter(child => child.hasClass('nexus-accordion'));
}

export function foldTitles(container: FakeElement): string[] {
  return accordions(container).map(fold => fold.querySelector('.nexus-accordion-title')?.textContent ?? '');
}

export function fold(container: FakeElement, title: string): FakeElement {
  const match = accordions(container).find(item => item.querySelector('.nexus-accordion-title')?.textContent === title);
  if (!match) throw new Error(`No fold titled ${title}; have ${foldTitles(container).join(', ')}`);
  return match;
}

export function foldItems(container: FakeElement, title: string): FakeElement {
  const items = fold(container, title).querySelector('.nexus-accordion-content .setting-items');
  if (!items) throw new Error(`Fold ${title} has no setting-items`);
  return items;
}

export function foldSummary(container: FakeElement, title: string): string {
  return fold(container, title).querySelector('.nexus-accordion-summary')?.textContent ?? '';
}

export function foldToggle(container: FakeElement, title: string): FakeElement {
  const toggle = fold(container, title).querySelector('.nexus-accordion-toggle');
  if (!toggle) throw new Error(`Fold ${title} has no toggle`);
  return toggle;
}

export function isFoldOpen(container: FakeElement, title: string): boolean {
  return fold(container, title).hasClass('is-open');
}

export function findRow(itemsEl: FakeElement, name: string): FakeElement {
  const row = rowsOf(itemsEl).find(item => rowName(item) === name);
  if (!row) throw new Error(`No row named ${name}; have ${rowNames(itemsEl).join(', ')}`);
  return row;
}

/** An app stand-in with vault-scoped local storage, as FoldStateStore uses. */
export function localStorageApp(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    vault: {},
    workspace: {},
    store,
    loadLocalStorage: jest.fn((key: string) => (store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null)),
    saveLocalStorage: jest.fn((key: string, value: unknown) => { store.set(key, JSON.parse(JSON.stringify(value))); })
  };
}

export const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** The control element of a row's first dropdown/toggle/slider/button. */
export function control(row: FakeElement, selector: 'select' | '.checkbox-container' | 'input.slider' | 'button' | '.extra-setting-button'): FakeElement {
  const el = row.querySelector(`.setting-item-control ${selector}`) ?? row.querySelector(selector);
  if (!el) throw new Error(`Row ${rowName(row)} has no ${selector}`);
  return el;
}

/** Pick a dropdown value as the user would (a 'change' event). */
export function choose(select: FakeElement, value: string): void {
  select.value = value;
  select.dispatch('change');
}

export function optionValues(select: FakeElement): string[] {
  return select.children.filter(child => child.tagName === 'OPTION').map(option => option.value);
}

export function optionLabels(select: FakeElement): string[] {
  return select.children.filter(child => child.tagName === 'OPTION').map(option => option.textContent);
}
