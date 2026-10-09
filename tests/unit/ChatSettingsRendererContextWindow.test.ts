import { Component, Setting } from 'obsidian';
import { SliderComponent } from '../mocks/obsidian/components';
import { createMockElement } from '../helpers/mockFactories';
import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../src/ui/chat/utils/ContextWindowSettings';

type SliderRenderer = ChatSettingsRenderer & {
  settings: {
    provider: string;
    model: string;
    contextWindowOverrides: Record<string, number>;
    thinking: { enabled: boolean; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  };
  staticModelsService: { findModel: () => { capabilities: { supportsThinking: boolean } } };
  notifyChange: jest.Mock;
  addContextWindowSlider: (content: HTMLElement, provider: string, model: string, maximum: number) => void;
  renderReasoningControls: (content: HTMLElement, variant: 'chat' | 'agent') => void;
};

it('keeps separate limits for two models and restores each slider value', () => {
  const renderer = Object.create(ChatSettingsRenderer.prototype) as SliderRenderer;
  renderer.settings = {
    provider: 'openai-codex', model: 'model-a', contextWindowOverrides: {},
    thinking: { enabled: false, effort: 'medium' }
  };
  renderer.notifyChange = jest.fn();
  const onChangeCallbacks: Array<(value: number) => void> = [];
  const onChange = jest.spyOn(SliderComponent.prototype, 'onChange').mockImplementation(function (callback) {
    onChangeCallbacks.push(callback);
    return this;
  });
  const setValue = jest.spyOn(SliderComponent.prototype, 'setValue');
  try {
    renderer.addContextWindowSlider(createMockElement('div'), 'openai-codex', 'model-a', 128_000);
    onChangeCallbacks[0](64_000);
    renderer.addContextWindowSlider(createMockElement('div'), 'openai-codex', 'model-b', 1_050_000);
    onChangeCallbacks[1](500_000);
    renderer.addContextWindowSlider(createMockElement('div'), 'openai-codex', 'model-a', 128_000);

    expect(renderer.settings.contextWindowOverrides).toEqual({
      [getContextWindowOverrideKey('openai-codex', 'model-a')]: 64_000,
      [getContextWindowOverrideKey('openai-codex', 'model-b')]: 500_000
    });
    expect(setValue).toHaveBeenLastCalledWith(64_000);
  } finally {
    onChange.mockRestore();
    setValue.mockRestore();
  }
});

it('clamps stale saved limits to the advertised model maximum', () => {
  expect(resolveContextWindowLimit(128_000, 1_050_000)).toBe(128_000);
  expect(resolveContextWindowLimit(128_000, Number.NaN)).toBe(128_000);
  expect(resolveContextWindowLimit(128_000, 512)).toBe(1024);
  expect(resolveContextWindowLimit(768, 512)).toBe(768);
});

it('updates the reasoning label during input, before change commits', () => {
  const renderer = Object.create(ChatSettingsRenderer.prototype) as SliderRenderer;
  renderer.settings = {
    provider: 'anthropic', model: 'thinking-model', contextWindowOverrides: {},
    thinking: { enabled: true, effort: 'medium' }
  };
  renderer.staticModelsService = { findModel: () => ({ capabilities: { supportsThinking: true } }) };
  renderer.notifyChange = jest.fn();
  let inputHandler: EventListenerOrEventListenerObject | undefined;
  let slider: SliderComponent | undefined;
  let valueDisplay: { setText: jest.Mock } | undefined;
  const register = jest.spyOn(Component.prototype, 'registerDomEvent').mockImplementation((_el, type, handler) => {
    if (type === 'input') inputHandler = handler;
  });
  const addSlider = jest.spyOn(Setting.prototype, 'addSlider').mockImplementation(function (callback) {
    slider = new SliderComponent(this.settingEl);
    callback(slider);
    const spanMock = this.controlEl.createSpan as jest.Mock;
    valueDisplay = spanMock.mock.results[0]?.value as { setText: jest.Mock };
    return this;
  });
  try {
    renderer.renderReasoningControls(createMockElement('div'), 'chat');
    expect(valueDisplay?.setText).toHaveBeenCalledWith('Medium');
    if (!slider || !inputHandler || typeof inputHandler !== 'function') throw new Error('Input slider was not registered');
    slider.sliderEl.value = '4';
    inputHandler(new Event('input'));
    expect(valueDisplay?.setText).toHaveBeenLastCalledWith('Max');
    expect(renderer.settings.thinking.effort).toBe('medium');
    expect(renderer.notifyChange).not.toHaveBeenCalled();
  } finally {
    register.mockRestore();
    addSlider.mockRestore();
  }
});
