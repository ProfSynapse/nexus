/**
 * Obsidian UI component mocks: Setting, input components, Notice, setIcon.
 */

import { createMockElement } from './core';
import { FakeElement, isFakeElement } from './dom';

// Element factory: a FakeElement subtree when the caller renders into a
// FakeElement (tests that observe structure), the call-recording mock otherwise.
function childOf(containerEl: unknown, tag: string, info?: Record<string, unknown> | string): HTMLElement {
  if (isFakeElement(containerEl)) {
    return containerEl.createEl(tag, info as never) as unknown as HTMLElement;
  }
  return createMockElement(tag);
}

function asFake(el: unknown): FakeElement | null {
  return isFakeElement(el) ? el : null;
}

// Setting mock. Given a FakeElement container it renders Obsidian's markup
// (setting-item > setting-item-info > name/description, setting-item-control)
// in place, so order, names, descriptions and disabled state can be asserted.
export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: unknown[] = [];
  /** Last value passed to setName/setDesc (strings only), for assertions. */
  name = '';
  desc = '';

  constructor(containerEl: HTMLElement) {
    this.settingEl = childOf(containerEl, 'div', 'setting-item');
    this.infoEl = childOf(this.settingEl, 'div', 'setting-item-info');
    this.nameEl = childOf(this.infoEl, 'div', 'setting-item-name');
    this.descEl = childOf(this.infoEl, 'div', 'setting-item-description');
    this.controlEl = childOf(this.settingEl, 'div', 'setting-item-control');
  }

  setClass(cls: string): this {
    asFake(this.settingEl)?.addClass(cls);
    return this;
  }

  setName(name: string | DocumentFragment): this {
    if (typeof name === 'string') {
      this.name = name;
      asFake(this.nameEl)?.setText(name);
    }
    return this;
  }

  setDesc(desc: string | DocumentFragment): this {
    if (typeof desc === 'string') {
      this.desc = desc;
      asFake(this.descEl)?.setText(desc);
    }
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  setHeading(): this {
    asFake(this.settingEl)?.addClass('setting-item-heading');
    return this;
  }

  setDisabled(disabled: boolean): this {
    asFake(this.settingEl)?.toggleClass('is-disabled', disabled);
    return this;
  }

  then(callback: (setting: this) => unknown): this {
    callback(this);
    return this;
  }

  private add<T>(component: T, callback: (component: T) => unknown): this {
    this.components.push(component);
    callback(component);
    return this;
  }

  addText(callback: (text: TextComponent) => void): this {
    return this.add(new TextComponent(this.controlEl), callback);
  }

  addTextArea(callback: (textarea: TextAreaComponent) => void): this {
    return this.add(new TextAreaComponent(this.controlEl), callback);
  }

  addDropdown(callback: (dropdown: DropdownComponent) => void): this {
    return this.add(new DropdownComponent(this.controlEl), callback);
  }

  addToggle(callback: (toggle: ToggleComponent) => void): this {
    return this.add(new ToggleComponent(this.controlEl), callback);
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    return this.add(new ButtonComponent(this.controlEl), callback);
  }

  addExtraButton(callback: (button: ExtraButtonComponent) => void): this {
    return this.add(new ExtraButtonComponent(this.controlEl), callback);
  }

  addSlider(callback: (slider: SliderComponent) => void): this {
    return this.add(new SliderComponent(this.controlEl), callback);
  }

  addProgressBar(callback: (bar: ProgressBarComponent) => void): this {
    return this.add(new ProgressBarComponent(this.controlEl), callback);
  }
}

// SettingGroup mock (Obsidian 1.11+): setting-group > setting-items, with the
// internal groupEl/listEl fields the real class carries.
export class SettingGroup {
  groupEl: HTMLElement;
  listEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.groupEl = childOf(containerEl, 'div', 'setting-group');
    this.listEl = childOf(this.groupEl, 'div', 'setting-items');
  }

  setHeading(_text: string | DocumentFragment): this {
    return this;
  }

  addClass(cls: string): this {
    asFake(this.groupEl)?.addClass(cls);
    return this;
  }

  addSetting(callback: (setting: Setting) => void): this {
    callback(new Setting(this.listEl));
    return this;
  }
}

// TextComponent mock
export class TextComponent {
  inputEl: HTMLInputElement;
  private value = '';
  private changeCallback?: (value: string) => void;

  constructor(containerEl: HTMLElement) {
    this.inputEl = childOf(containerEl, 'input', { type: 'text' }) as HTMLInputElement;
  }

  setPlaceholder(_placeholder: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    const fake = asFake(this.inputEl);
    if (fake) fake.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.changeCallback = callback;
    return this;
  }

  // Helper for tests to trigger change
  triggerChange(value: string): void {
    this.value = value;
    this.changeCallback?.(value);
  }
}

// TextAreaComponent mock
export class TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  private value = '';

  constructor(containerEl: HTMLElement) {
    this.inputEl = childOf(containerEl, 'textarea') as HTMLTextAreaElement;
  }

  setPlaceholder(_placeholder: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  onChange(_callback: (value: string) => void): this {
    return this;
  }
}

// DropdownComponent mock. With a FakeElement container, options are real
// <option> children of selectEl and `selectEl.value`/`disabled` track the API.
export class DropdownComponent {
  selectEl: HTMLSelectElement;
  private value = '';
  private changeCallback?: (value: string) => unknown;

  constructor(containerEl: HTMLElement) {
    this.selectEl = childOf(containerEl, 'select', 'dropdown') as HTMLSelectElement;
    // Like Obsidian: a 'change' event on the select reports its current value.
    asFake(this.selectEl)?.addEventListener('change', () => {
      const fake = asFake(this.selectEl);
      if (fake) this.changeCallback?.(fake.value);
    });
  }

  addOption(value: string, display: string): this {
    asFake(this.selectEl)?.createEl('option', { value, text: display });
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    const fake = asFake(this.selectEl);
    if (fake) fake.value = value;
    return this;
  }

  getValue(): string {
    return asFake(this.selectEl)?.value ?? this.value;
  }

  setDisabled(disabled: boolean): this {
    const fake = asFake(this.selectEl);
    if (fake) fake.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.changeCallback = callback;
    return this;
  }

  /** Test helper: select a value as the user would. */
  trigger(value: string): unknown {
    this.setValue(value);
    return this.changeCallback?.(value);
  }
}

// ToggleComponent mock
export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;
  private changeCallback?: (value: boolean) => unknown;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = childOf(containerEl, 'div', 'checkbox-container');
    // Like Obsidian: clicking the switch flips it and reports the new value.
    asFake(this.toggleEl)?.addEventListener('click', () => {
      if (asFake(this.toggleEl)?.disabled) return;
      this.setValue(!this.value);
      this.changeCallback?.(this.value);
    });
  }

  setValue(value: boolean): this {
    this.value = value;
    asFake(this.toggleEl)?.toggleClass('is-enabled', value);
    return this;
  }

  getValue(): boolean {
    return this.value;
  }

  setDisabled(disabled: boolean): this {
    const fake = asFake(this.toggleEl);
    if (fake) fake.disabled = disabled;
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.changeCallback = callback;
    return this;
  }

  /** Test helper: flip the toggle as the user would. */
  trigger(value: boolean): unknown {
    this.setValue(value);
    return this.changeCallback?.(value);
  }
}

// SliderComponent mock. Obsidian 1.13+ draws its own `span.slider-value`
// before the range input and keeps it current (`updateDisplay`), formatted by
// `setDisplayFormat` when one is set. In FakeElement mode the mock reproduces
// that element, because a second, plugin-made readout next to it is exactly
// the duplicate this shape exists to catch.
export class SliderComponent {
  sliderEl: HTMLInputElement;
  valueEl: HTMLElement | null = null;
  disabled = false;
  min = 0;
  max = 100;
  step = 1;
  private value = 0;
  private displayFormat: ((value: number) => string) | null = null;
  private changeCallback?: (value: number) => unknown;

  constructor(containerEl: HTMLElement) {
    if (isFakeElement(containerEl)) {
      this.valueEl = containerEl.createSpan('slider-value') as unknown as HTMLElement;
      this.sliderEl = containerEl.createEl('input', { cls: 'slider', type: 'range' }) as unknown as HTMLInputElement;
      const fake = this.sliderEl as unknown as FakeElement;
      fake.addEventListener('input', () => this.updateDisplay());
      fake.addEventListener('change', () => { this.changeCallback?.(this.getValue()); });
    } else {
      this.sliderEl = createMockElement('input') as HTMLInputElement;
    }
  }

  private updateDisplay(): void {
    const valueEl = asFake(this.valueEl);
    if (!valueEl) return;
    const value = this.getValue();
    valueEl.setText(this.displayFormat ? this.displayFormat(value) : String(value));
  }

  setLimits(min: number, max: number, step: number): this {
    this.min = min;
    this.max = max;
    this.step = step;
    this.updateDisplay();
    return this;
  }

  setValue(value: number): this {
    this.value = value;
    const fake = asFake(this.sliderEl);
    if (fake) fake.value = String(value);
    this.updateDisplay();
    return this;
  }

  getValue(): number {
    const fake = asFake(this.sliderEl);
    return fake ? Number(fake.value) : this.value;
  }

  setDisplayFormat(format: (value: number) => string): this {
    this.displayFormat = format;
    this.updateDisplay();
    return this;
  }

  setInstant(_instant: boolean): this {
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    const fake = asFake(this.sliderEl);
    if (fake) fake.disabled = disabled;
    return this;
  }

  setDynamicTooltip(): this {
    return this;
  }

  onChange(callback: (value: number) => unknown): this {
    this.changeCallback = callback;
    return this;
  }

  /** Test helper: drag to a value (input events) without committing. */
  drag(value: number): void {
    const fake = asFake(this.sliderEl);
    if (!fake) return;
    fake.value = String(value);
    fake.dispatch('input');
  }

  /** Test helper: release at a value (input then change). */
  commit(value: number): unknown {
    const fake = asFake(this.sliderEl);
    if (!fake) {
      this.value = value;
      return this.changeCallback?.(value);
    }
    this.drag(value);
    fake.dispatch('change');
    return undefined;
  }
}

// ButtonComponent mock
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  private clickCallback?: (evt?: unknown) => unknown;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = childOf(containerEl, 'button') as HTMLButtonElement;
    asFake(this.buttonEl)?.addEventListener('click', event => { this.clickCallback?.(event); });
  }

  setButtonText(text: string): this {
    asFake(this.buttonEl)?.setText(text);
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
    asFake(this.buttonEl)?.setAttribute('aria-label', tooltip);
    return this;
  }

  setClass(cls: string): this {
    asFake(this.buttonEl)?.addClass(cls);
    return this;
  }

  setCta(): this {
    asFake(this.buttonEl)?.addClass('mod-cta');
    return this;
  }

  setWarning(): this {
    asFake(this.buttonEl)?.addClass('mod-warning');
    return this;
  }

  setDisabled(disabled: boolean): this {
    const fake = asFake(this.buttonEl);
    if (fake) fake.disabled = disabled;
    return this;
  }

  onClick(callback: (evt?: unknown) => unknown): this {
    this.clickCallback = callback;
    return this;
  }

  // Helper for tests to trigger click
  click(): void {
    this.clickCallback?.();
  }
}

// ExtraButtonComponent mock
export class ExtraButtonComponent {
  extraSettingsEl: HTMLElement;
  private clickCallback?: () => unknown;

  constructor(containerEl: HTMLElement) {
    this.extraSettingsEl = childOf(containerEl, 'div', 'clickable-icon extra-setting-button');
    asFake(this.extraSettingsEl)?.addEventListener('click', () => { this.clickCallback?.(); });
  }

  setIcon(icon: string): this {
    asFake(this.extraSettingsEl)?.setAttribute('data-icon', icon);
    return this;
  }

  setTooltip(tooltip: string): this {
    asFake(this.extraSettingsEl)?.setAttribute('aria-label', tooltip);
    return this;
  }

  setDisabled(disabled: boolean): this {
    const fake = asFake(this.extraSettingsEl);
    if (fake) fake.disabled = disabled;
    return this;
  }

  onClick(callback: () => unknown): this {
    this.clickCallback = callback;
    return this;
  }

  click(): void {
    this.clickCallback?.();
  }
}

// ProgressBarComponent mock
export class ProgressBarComponent {
  progressBar: HTMLElement;
  private value = 0;

  constructor(containerEl: HTMLElement) {
    this.progressBar = childOf(containerEl, 'div', 'setting-progress-bar');
  }

  setValue(value: number): this {
    this.value = value;
    return this;
  }

  getValue(): number {
    return this.value;
  }

  setVisibility(visible: boolean): this {
    const fake = asFake(this.progressBar);
    if (fake) fake.hidden = !visible;
    return this;
  }
}

// Notice mock
export class Notice {
  constructor(_message: string, _timeout?: number) {
    // Mock - in tests we can spy on constructor calls
  }

  hide(): void {
    // Mock implementation
  }
}

// AbstractInputSuggest<T> — minimal base for input autocompleters (e.g.
// NoteInputSuggester). Real Obsidian wires popover lifecycle; the mock only
// needs to be a constructible base so subclasses load, plus the handful of
// instance methods consumers call (setValue/close/limit).
export class AbstractInputSuggest<T> {
  limit = 10;
  constructor(
    protected app: unknown,
    protected inputEl: HTMLInputElement
  ) {}

  setValue(value: string): void {
    if (this.inputEl) this.inputEl.value = value;
  }

  close(): void {
    // Mock implementation
  }

  // Subclasses override; base provides no-op defaults.
  async getSuggestions(_query: string): Promise<T[]> {
    return [];
  }

  renderSuggestion(_value: T, _el: HTMLElement): void {
    // Mock implementation
  }

  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {
    // Mock implementation
  }
}

// setIcon mock
export function setIcon(element: HTMLElement, iconId: string): void {
  // Records the icon on FakeElements so structure tests can assert it.
  asFake(element)?.setAttribute('data-icon', iconId);
}

// Debouncer<Args, V> — structural type matching Obsidian's public API.
// Consumers import only for type positions, so a minimal shape is enough.
export interface Debouncer<Args extends unknown[], V = void> {
  (...args: Args): V | undefined;
  cancel(): this;
  run(): V | undefined;
}

// debounce mock — faithful implementation of Obsidian's debounce signature
// Supports leading-edge behavior required by ToolStatusBarController.
// Does not use fake timers — real setTimeout with real Date.now for accurate timing tests.
type DebouncedFn<T extends (...args: unknown[]) => unknown> = T & {
  cancel: () => void;
};

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  timeout: number,
  leading = false
): DebouncedFn<T> {
  let pendingHandle: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: unknown[] | null = null;
  let lastInvokeAt = 0;

  const wrapped = ((...args: unknown[]): unknown => {
    const now = Date.now();

    if (leading && (lastInvokeAt === 0 || now - lastInvokeAt >= timeout)) {
      // Leading-edge fire
      lastInvokeAt = now;
      return fn(...args);
    }

    // Trailing-edge queue (or suppressed during active window for leading mode)
    pendingArgs = args;
    if (!pendingHandle) {
      const delay = leading ? timeout - (now - lastInvokeAt) : timeout;
      pendingHandle = setTimeout(() => {
        pendingHandle = null;
        lastInvokeAt = Date.now();
        if (pendingArgs) {
          const finalArgs = pendingArgs;
          pendingArgs = null;
          fn(...finalArgs);
        }
      }, Math.max(0, delay));
    }
    return undefined;
  }) as DebouncedFn<T>;

  wrapped.cancel = () => {
    if (pendingHandle) {
      clearTimeout(pendingHandle);
      pendingHandle = null;
    }
    pendingArgs = null;
  };

  return wrapped;
}
