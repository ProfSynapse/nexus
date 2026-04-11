/**
 * Obsidian UI component mocks: Setting, input components, Notice, setIcon.
 */

import { createMockElement } from './core';

// Setting mock
export class Setting {
  settingEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(_containerEl: HTMLElement) {
    this.settingEl = createMockElement('div');
    this.controlEl = createMockElement('div');
  }

  setClass(_cls: string): this {
    return this;
  }

  setName(_name: string): this {
    return this;
  }

  setDesc(_desc: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  addText(callback: (text: TextComponent) => void): this {
    callback(new TextComponent(this.settingEl));
    return this;
  }

  addTextArea(callback: (textarea: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.settingEl));
    return this;
  }

  addDropdown(callback: (dropdown: DropdownComponent) => void): this {
    callback(new DropdownComponent(this.settingEl));
    return this;
  }

  addToggle(callback: (toggle: ToggleComponent) => void): this {
    callback(new ToggleComponent(this.settingEl));
    return this;
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.settingEl));
    return this;
  }

  addSlider(callback: (slider: SliderComponent) => void): this {
    callback(new SliderComponent(this.settingEl));
    return this;
  }
}

// TextComponent mock
export class TextComponent {
  inputEl: HTMLInputElement;
  private value = '';
  private changeCallback?: (value: string) => void;

  constructor(_containerEl: HTMLElement) {
    this.inputEl = createMockElement('input') as HTMLInputElement;
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

  constructor(_containerEl: HTMLElement) {
    this.inputEl = createMockElement('textarea') as HTMLTextAreaElement;
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

// DropdownComponent mock
export class DropdownComponent {
  selectEl: HTMLSelectElement;
  private value = '';

  constructor(_containerEl: HTMLElement) {
    this.selectEl = createMockElement('select') as HTMLSelectElement;
  }

  addOption(_value: string, _display: string): this {
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

// ToggleComponent mock
export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;

  constructor(_containerEl: HTMLElement) {
    this.toggleEl = createMockElement('div');
  }

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  getValue(): boolean {
    return this.value;
  }

  onChange(_callback: (value: boolean) => void): this {
    return this;
  }
}

// SliderComponent mock
export class SliderComponent {
  sliderEl: HTMLElement;
  private value = 0;

  constructor(_containerEl: HTMLElement) {
    this.sliderEl = createMockElement('input');
  }

  setLimits(_min: number, _max: number, _step: number): this {
    return this;
  }

  setValue(value: number): this {
    this.value = value;
    return this;
  }

  getValue(): number {
    return this.value;
  }

  setDynamicTooltip(): this {
    return this;
  }

  onChange(_callback: (value: number) => void): this {
    return this;
  }
}

// ButtonComponent mock
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  private clickCallback?: () => void;

  constructor(_containerEl: HTMLElement) {
    this.buttonEl = createMockElement('button') as HTMLButtonElement;
  }

  setButtonText(_text: string): this {
    return this;
  }

  setIcon(_icon: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  setClass(_cls: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  onClick(callback: () => void): this {
    this.clickCallback = callback;
    return this;
  }

  // Helper for tests to trigger click
  click(): void {
    this.clickCallback?.();
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

// setIcon mock
export function setIcon(_element: HTMLElement, _iconId: string): void {
  // Mock implementation
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
