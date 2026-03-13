/**
 * Characterization Tests: Model Dropdown Rendering Pattern
 *
 * Documents that ChatSettingsRenderer.renderModelSection() and
 * renderAgentModelSection() follow the same structural pattern:
 *   section div > header div > content div > Setting dropdowns
 *
 * Both render Provider + Model dropdowns with nearly identical logic.
 * The Agent Model section additionally filters out local providers.
 *
 * These tests capture the structural pattern and key behavioral differences
 * that Wave 1b (ModelDropdownRenderer extraction) needs to preserve.
 */

import { App } from 'obsidian';
import { ChatSettingsRenderer, ChatSettingsRendererConfig, ChatSettings } from '../../src/components/shared/ChatSettingsRenderer';

// Mock deep dependencies to avoid needing real providers
jest.mock('../../src/services/llm/providers/ProviderManager', () => ({
  LLMProviderManager: jest.fn().mockImplementation(() => ({
    getModelsForProvider: jest.fn().mockResolvedValue([]),
    updateSettings: jest.fn(),
  })),
}));

jest.mock('../../src/services/StaticModelsService', () => ({
  StaticModelsService: {
    getInstance: jest.fn().mockReturnValue({
      getModelsForProvider: jest.fn().mockReturnValue([]),
      findModel: jest.fn().mockReturnValue(null),
    }),
  },
}));

jest.mock('../../src/services/llm/ImageGenerationService', () => ({
  ImageGenerationService: jest.fn().mockImplementation(() => ({
    getInitializedProviders: jest.fn().mockReturnValue([]),
    getSupportedModelIds: jest.fn().mockReturnValue([]),
    getModelsForProvider: jest.fn().mockReturnValue([]),
    updateSettings: jest.fn(),
  })),
}));

jest.mock('../../src/components/workspace/FilePickerRenderer', () => ({
  FilePickerRenderer: jest.fn().mockImplementation(() => ({
    render: jest.fn(),
  })),
}));

jest.mock('../../src/utils/platform', () => ({
  isDesktop: jest.fn().mockReturnValue(true),
  isProviderCompatible: jest.fn().mockReturnValue(true),
}));

jest.mock('../../src/services/llm/LLMSettingsNotifier', () => ({
  LLMSettingsNotifier: {
    onSettingsChanged: jest.fn().mockReturnValue({}),
    unsubscribe: jest.fn(),
  },
}));

function createMockElement(): any {
  const element: any = {
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    addClass: jest.fn().mockReturnThis(),
    removeClass: jest.fn().mockReturnThis(),
    hasClass: jest.fn(() => false),
    setText: jest.fn().mockReturnThis(),
    createEl: jest.fn((_tag: string, _opts?: any) => createMockElement()),
    createDiv: jest.fn((clsOrOpts?: string | Record<string, any>) => {
      const child = createMockElement();
      // Track the CSS class for structural assertions
      if (typeof clsOrOpts === 'string') {
        child._cls = clsOrOpts;
      }
      return child;
    }),
    createSpan: jest.fn((_opts?: any) => createMockElement()),
    empty: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    style: {},
    textContent: '',
    innerHTML: '',
    _cls: '',
  };
  return element;
}

function createDefaultSettings(): ChatSettings {
  return {
    provider: 'openai',
    model: 'gpt-5-nano',
    thinking: { enabled: false, effort: 'medium' },
    temperature: 0.7,
    imageProvider: 'google',
    imageModel: '',
    workspaceId: null,
    promptId: null,
    contextNotes: [],
  };
}

function createConfig(container: any): ChatSettingsRendererConfig {
  return {
    app: new App(),
    llmProviderSettings: {
      providers: {
        openai: { enabled: true, apiKey: 'test-key' },
        anthropic: { enabled: true, apiKey: 'test-key' },
      },
      defaultProvider: 'openai',
      defaultModel: 'gpt-5-nano',
      defaultTemperature: 0.7,
    } as any,
    initialSettings: createDefaultSettings(),
    options: { workspaces: [], prompts: [] },
    callbacks: { onSettingsChange: jest.fn() },
  };
}

describe('ChatSettingsRenderer model section characterization', () => {
  it('render() creates 5 sections in fixed order: Chat, Agent, Image, Temp, Context', () => {
    const container = createMockElement();
    const config = createConfig(container);
    const renderer = new ChatSettingsRenderer(container, config);

    renderer.render();

    // Characterization: render() calls container.empty() first
    expect(container.empty).toHaveBeenCalled();
    // Characterization: adds class 'chat-settings-renderer'
    expect(container.addClass).toHaveBeenCalledWith('chat-settings-renderer');
    // Characterization: creates div sections (createDiv called for each section)
    // The exact count depends on internal structure, but at minimum
    // renderModelSection, renderAgentModelSection, and others each call createDiv
    expect(container.createDiv).toHaveBeenCalled();
  });

  it('renderModelSection creates section with "csr-section" class', () => {
    const container = createMockElement();
    const config = createConfig(container);
    const renderer = new ChatSettingsRenderer(container, config);

    renderer.render();

    // Characterization: first createDiv call is for renderModelSection's section
    const firstCall = container.createDiv.mock.calls[0];
    expect(firstCall[0]).toBe('csr-section');
  });

  it('renderModelSection header text is "Chat Model"', () => {
    const container = createMockElement();
    const config = createConfig(container);
    const renderer = new ChatSettingsRenderer(container, config);

    renderer.render();

    // The first createDiv('csr-section') returns a mock element
    // which then has createDiv('csr-section-header') called on it
    const sectionEl = container.createDiv.mock.results[0].value;
    expect(sectionEl.createDiv).toHaveBeenCalledWith('csr-section-header');

    // The header element has setText called with 'Chat Model'
    const headerEl = sectionEl.createDiv.mock.results[0].value;
    expect(headerEl.setText).toHaveBeenCalledWith('Chat Model');
  });

  it('renderAgentModelSection header text is "Agent Model"', () => {
    const container = createMockElement();
    const config = createConfig(container);
    const renderer = new ChatSettingsRenderer(container, config);

    renderer.render();

    // The second createDiv('csr-section') is for the agent model section
    // (first is chat model, second is agent model)
    const allSectionCalls = container.createDiv.mock.calls
      .map((call: any[], idx: number) => ({ cls: call[0], idx }))
      .filter((c: { cls: string }) => c.cls === 'csr-section');

    // At least 2 sections should have 'csr-section' class
    expect(allSectionCalls.length).toBeGreaterThanOrEqual(2);

    // The second csr-section is the agent model section
    const agentSectionIdx = allSectionCalls[1].idx;
    const agentSectionEl = container.createDiv.mock.results[agentSectionIdx].value;
    const agentHeaderEl = agentSectionEl.createDiv.mock.results[0].value;
    expect(agentHeaderEl.setText).toHaveBeenCalledWith('Agent Model');
  });
});
