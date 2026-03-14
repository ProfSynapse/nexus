/**
 * Obsidian UI component mocks: Setting, input components, Notice, setIcon.
 */

import { createMockElement } from './core';

// Setting mock
export class Setting {
  settingEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = createMockElement('div');
    this.controlEl = createMockElement('div');
  }

  setClass(cls: string): this {
    return this;
  }

  setName(name: string): this {
    return this;
  }

  setDesc(desc: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
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

  addSlider(callback: (slider: SliderComponent) => any): this {
    callback(new SliderComponent(this.settingEl));
    return this;
  }
}

// TextComponent mock
export class TextComponent {
  inputEl: HTMLInputElement;
  private value = '';
  private changeCallback?: (value: string) => void;

  constructor(containerEl: HTMLElement) {
    this.inputEl = createMockElement('input') as HTMLInputElement;
  }

  setPlaceholder(placeholder: string): this {
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

  constructor(containerEl: HTMLElement) {
    this.inputEl = createMockElement('textarea') as HTMLTextAreaElement;
  }

  setPlaceholder(placeholder: string): this {
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
    return this;
  }
}

// DropdownComponent mock
export class DropdownComponent {
  selectEl: HTMLSelectElement;
  private value = '';

  constructor(containerEl: HTMLElement) {
    this.selectEl = createMockElement('select') as HTMLSelectElement;
  }

  addOption(value: string, display: string): this {
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
    return this;
  }
}

// ToggleComponent mock
export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = createMockElement('div');
  }

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  getValue(): boolean {
    return this.value;
  }

  onChange(callback: (value: boolean) => void): this {
    return this;
  }
}

// SliderComponent mock
export class SliderComponent {
  sliderEl: HTMLElement;
  private value = 0;

  constructor(containerEl: HTMLElement) {
    this.sliderEl = createMockElement('input');
  }

  setLimits(min: number, max: number, step: number): this {
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

  onChange(callback: (value: number) => void): this {
    return this;
  }
}

// ButtonComponent mock
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  private clickCallback?: () => void;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = createMockElement('button') as HTMLButtonElement;
  }

  setButtonText(text: string): this {
    return this;
  }

  setIcon(icon: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
    return this;
  }

  setClass(cls: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setDisabled(disabled: boolean): this {
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
  constructor(message: string, timeout?: number) {
    // Mock - in tests we can spy on constructor calls
  }

  hide(): void {
    // Mock implementation
  }
}

// setIcon mock
export function setIcon(element: HTMLElement, iconId: string): void {
  // Mock implementation
}
