import { SettingGroup } from 'obsidian';

/**
 * A heading-less Obsidian SettingGroup plus the element its rows live in.
 *
 * SettingGroup (1.11+) only exposes `addSetting`, but a settings block that
 * redraws its rows needs to empty and refill the row list. The group's own
 * `groupEl`/`listEl` fields are read here, in one place, so the mock and any
 * future API change touch a single function.
 */
export interface SettingGroupHandle {
  group: SettingGroup;
  groupEl: HTMLElement;
  itemsEl: HTMLElement;
}

interface SettingGroupInternals {
  groupEl?: HTMLElement;
  listEl?: HTMLElement;
}

export function createSettingGroup(container: HTMLElement, cls?: string): SettingGroupHandle {
  const group = new SettingGroup(container);
  if (cls) group.addClass(cls);
  const internals = group as unknown as SettingGroupInternals;
  const groupEl = internals.groupEl ?? container.lastElementChild as HTMLElement | null ?? container.createDiv({ cls: 'setting-group' });
  const itemsEl = internals.listEl
    ?? groupEl.querySelector<HTMLElement>('.setting-items')
    ?? groupEl.createDiv({ cls: 'setting-items' });
  return { group, groupEl, itemsEl };
}
