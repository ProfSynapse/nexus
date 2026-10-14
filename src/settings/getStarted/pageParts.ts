/**
 * Building blocks shared by the Get started row and pages: the page head with
 * the BackButton, navigable rows, numbered steps and status values. Mobile-safe:
 * imports only `obsidian` and other DOM-only helpers.
 */
import { Component, Setting, setIcon } from 'obsidian';
import { BackButton } from '../components/BackButton';

export function renderPageHead(
  container: HTMLElement,
  options: { backLabel: string; onBack: () => void; title: string },
  component: Component
): HTMLElement {
  const head = container.createDiv({ cls: 'nexus-page-head' });
  new BackButton(head, options.backLabel, options.onBack, component);
  head.createEl('h2', { cls: 'nexus-page-title', text: options.title });
  return head;
}

/** Replace a row name with `<prefix><text>`, keeping the text as its own node. */
function fillName(nameEl: HTMLElement, text: string, prefix?: (nameEl: HTMLElement) => void): void {
  nameEl.empty();
  prefix?.(nameEl);
  nameEl.appendText(text);
}

/** A row name preceded by a Lucide icon. */
export function setIconName(setting: Setting, icon: string, text: string): void {
  fillName(setting.nameEl, text, nameEl => setIcon(nameEl.createSpan({ cls: 'nexus-row-icon' }), icon));
}

/** A row name preceded by a numbered step badge. */
export function setStepName(setting: Setting, step: number, text: string): void {
  fillName(setting.nameEl, text, nameEl => {
    nameEl.createSpan({ cls: 'nexus-step', text: String(step) });
  });
}

/** A status value in a row's control area, with a check mark when it is good news. */
export function addStatus(setting: Setting, text: string, ok = false): HTMLElement {
  const statusEl = setting.controlEl.createDiv({ cls: 'setting-item-value nexus-status' });
  if (ok) {
    statusEl.addClass('is-ok');
    setIcon(statusEl.createSpan({ cls: 'nexus-status-check' }), 'circle-check');
  }
  statusEl.appendText(text);
  return statusEl;
}

/** Make a whole row act as a button: click, Enter and Space all run `onActivate`. */
export function makeRowActivatable(settingEl: HTMLElement, onActivate: () => void, component: Component): void {
  settingEl.setAttribute('role', 'button');
  settingEl.setAttribute('tabindex', '0');
  component.registerDomEvent(settingEl, 'click', () => onActivate());
  component.registerDomEvent(settingEl, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate();
    }
  });
}

export interface NavigableRowOptions {
  icon?: string;
  name: string;
  desc: string;
  value?: string;
  onOpen: () => void;
}

/** A row that opens another page: name (with icon), description, optional value and a chevron. */
export function addNavigableRow(container: HTMLElement, options: NavigableRowOptions, component: Component): Setting {
  const setting = new Setting(container).setDesc(options.desc);
  setting.settingEl.addClass('mod-navigable');
  if (options.icon) {
    setIconName(setting, options.icon, options.name);
  } else {
    fillName(setting.nameEl, options.name);
  }
  if (options.value) {
    setting.controlEl.createDiv({ cls: 'setting-item-value', text: options.value });
  }
  setIcon(setting.controlEl.createDiv({ cls: 'setting-item-chevron' }), 'chevron-right');
  makeRowActivatable(setting.settingEl, options.onOpen, component);
  return setting;
}
