import { SliderComponent } from '../mocks/obsidian/components';
import { createMockElement } from '../helpers/mockFactories';
import { ChatSettingsRenderer } from '../../src/components/shared/ChatSettingsRenderer';

type RenderReasoningControls = {
  settings: Record<string, unknown>;
  staticModelsService: { findModel: () => { capabilities: { supportsThinking: boolean } } };
  notifyChange: () => void;
  renderReasoningControls: (content: HTMLElement, variant: 'chat' | 'agent') => void;
};

it.each(['chat', 'agent'] as const)('reaches Extra high and Max in the %s effort slider', variant => {
  const settings = {
    provider: 'anthropic', model: 'claude-opus-5',
    agentProvider: 'anthropic', agentModel: 'claude-opus-5',
    thinking: { enabled: true, effort: 'high' },
    agentThinking: { enabled: true, effort: 'high' }
  };
  const renderer = Object.create(ChatSettingsRenderer.prototype) as RenderReasoningControls;
  renderer.settings = settings;
  renderer.staticModelsService = { findModel: () => ({ capabilities: { supportsThinking: true } }) };
  renderer.notifyChange = jest.fn();

  const limits = jest.spyOn(SliderComponent.prototype, 'setLimits');
  const callbacks: Array<(value: number) => void> = [];
  const onChange = jest.spyOn(SliderComponent.prototype, 'onChange').mockImplementation(function (callback) {
    callbacks.push(callback);
    return this;
  });
  try {
    renderer.renderReasoningControls(createMockElement('div'), variant);
    expect(limits).toHaveBeenCalledWith(0, 4, 1);
    callbacks[0](3);
    expect(variant === 'chat' ? settings.thinking.effort : settings.agentThinking.effort).toBe('xhigh');
    callbacks[0](4);
    expect(variant === 'chat' ? settings.thinking.effort : settings.agentThinking.effort).toBe('max');
  } finally {
    limits.mockRestore();
    onChange.mockRestore();
  }
});
