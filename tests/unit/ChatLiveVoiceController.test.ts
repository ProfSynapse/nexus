import { Component, createMockElement } from 'obsidian';
import { ChatLiveVoiceController } from '../../src/ui/chat/controllers/ChatLiveVoiceController';
import type { ChatInput } from '../../src/ui/chat/components/ChatInput';
import type { ToolStatusBar } from '../../src/ui/chat/components/ToolStatusBar';

const mockSessionStart = jest.fn();
const mockSessionStop = jest.fn();
const mockGetAvailability = jest.fn();
const mockCreateSession = jest.fn();
var mockRealtimeVoiceService: jest.Mock;

jest.mock('../../src/services/realtimeVoice/RealtimeVoiceService', () => ({
  RealtimeVoiceService: (mockRealtimeVoiceService = jest.fn().mockImplementation(() => ({
    getAvailability: mockGetAvailability,
    createSession: mockCreateSession,
  }))),
}));

describe('ChatLiveVoiceController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSessionStart.mockReset();
    mockSessionStop.mockReset();
    mockGetAvailability.mockReset();
    mockCreateSession.mockReset();
    mockRealtimeVoiceService.mockClear();
    mockSessionStart.mockResolvedValue(undefined);
    mockGetAvailability.mockReturnValue({ available: true });
    mockCreateSession.mockReturnValue({
      start: mockSessionStart,
      stop: mockSessionStop,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  function createHarness(hasConversation = true) {
    const app = {
      plugins: {
        getPlugin: jest.fn(() => ({
          settings: {
            settings: {
              llmProviders: {
                providers: {
                  openai: {
                    enabled: true,
                    apiKey: 'test-openai-key',
                  },
                },
                defaultModel: { provider: 'openai', model: 'gpt-4o' },
                defaultRealtimeVoiceModel: {
                  provider: 'openai',
                  model: 'gpt-realtime-2',
                  voice: 'marin',
                  source: 'user',
                },
              },
            },
          },
        })),
      },
    };
    const chatInput = {
      setLiveVoiceState: jest.fn(),
    } as unknown as ChatInput;
    const toolStatusBar = {
      pushLiveVoiceStatus: jest.fn(),
      clearLiveVoiceStatus: jest.fn(),
    } as unknown as ToolStatusBar;
    const liveVoiceButton = createMockElement('button');
    const component = new Component();
    const onTranscriptMessage = jest.fn();
    const getConversationContext = jest.fn(() => '<conversation_context>Prior chat</conversation_context>');
    const registerDomEventSpy = jest.spyOn(component, 'registerDomEvent');
    const controller = new ChatLiveVoiceController({
      app: app as never,
      chatInput,
      toolStatusBar,
      liveVoiceButton,
      getHasConversation: () => hasConversation,
      getConversationContext,
      onTranscriptMessage,
      component,
    });

    return {
      app,
      chatInput,
      component,
      controller,
      getConversationContext,
      liveVoiceButton,
      onTranscriptMessage,
      registerDomEventSpy,
      toolStatusBar,
    };
  }

  it('reports a clear error when no conversation is selected', async () => {
    const { chatInput, controller, toolStatusBar } = createHarness(false);

    await controller.start();

    expect(chatInput.setLiveVoiceState).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenCalledWith(
      'Select or create a conversation to use live voice.',
      'failed'
    );
  });

  it('starts a realtime voice session when available', async () => {
    const { chatInput, controller, liveVoiceButton, toolStatusBar } = createHarness(true);

    await controller.start();

    expect(controller.getState()).toBe('connecting');
    expect(chatInput.setLiveVoiceState).toHaveBeenCalledWith('connecting');
    expect(liveVoiceButton.addClass).toHaveBeenCalledWith('chat-live-voice-button-active');
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenCalledWith('Connecting live voice...', 'present');
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateSession.mock.calls[0]?.[0].instructions).toContain('<conversation_context>Prior chat</conversation_context>');
    expect(mockSessionStart).toHaveBeenCalledTimes(1);
  });

  it('prefers resolved chat voice settings when provided', async () => {
    const { app, chatInput, component, getConversationContext, liveVoiceButton, onTranscriptMessage, toolStatusBar } = createHarness(true);
    const resolvedSettings = {
      providers: {
        openai: {
          enabled: true,
          apiKey: 'override-key'
        }
      },
      defaultModel: { provider: 'openai', model: 'gpt-4o' },
      defaultRealtimeVoiceModel: {
        provider: 'openai',
        model: 'gpt-realtime-2',
        voice: 'marin',
        source: 'user'
      }
    };
    const controllerWithOverride = new ChatLiveVoiceController({
      app: app as never,
      chatInput,
      toolStatusBar,
      liveVoiceButton,
      getHasConversation: () => true,
      getLLMSettings: () => resolvedSettings as never,
      getConversationContext,
      onTranscriptMessage,
      component,
    });

    await controllerWithOverride.start();

    expect(mockRealtimeVoiceService).toHaveBeenLastCalledWith(resolvedSettings);
  });

  it('reports unavailable realtime voice settings', async () => {
    mockGetAvailability.mockReturnValue({ available: false, reason: 'OpenAI is not enabled and configured for live voice.' });
    const { chatInput, controller, toolStatusBar } = createHarness(true);

    await controller.start();

    expect(controller.getState()).toBe('error');
    expect(chatInput.setLiveVoiceState).toHaveBeenLastCalledWith('error');
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenLastCalledWith(
      'OpenAI is not enabled and configured for live voice.',
      'failed'
    );
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('stops the live voice UI and clears the status line', () => {
    const { chatInput, controller, liveVoiceButton, toolStatusBar } = createHarness(true);

    controller.start();
    controller.stop();

    expect(controller.getState()).toBe('inactive');
    expect(chatInput.setLiveVoiceState).toHaveBeenLastCalledWith('inactive');
    expect(liveVoiceButton.removeClass).toHaveBeenCalledWith('chat-live-voice-button-active');
    expect(mockSessionStop).toHaveBeenCalledTimes(1);
    expect(toolStatusBar.clearLiveVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it('wires the header live voice button to start the controller', async () => {
    const { controller, liveVoiceButton, registerDomEventSpy } = createHarness(true);
    const registration = registerDomEventSpy.mock.calls.find(([element, eventName]) => (
      element === liveVoiceButton && eventName === 'click'
    ));

    expect(registration).toBeDefined();
    const handler = registration?.[2] as EventListener;
    handler(new Event('click'));
    await Promise.resolve();

    expect(controller.getState()).toBe('connecting');
  });

  it('forwards completed user transcripts into the chat stream', async () => {
    const { controller, onTranscriptMessage, toolStatusBar } = createHarness(true);
    await controller.start();
    const createSessionRequest = mockCreateSession.mock.calls[0]?.[0];

    createSessionRequest.callbacks.onUserTranscript('  Hello   Nexus.  ');

    expect(onTranscriptMessage).toHaveBeenCalledWith('user', 'Hello Nexus.');
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenLastCalledWith('Heard: Hello Nexus.', 'present');
  });

  it('buffers assistant transcript deltas and forwards the completed assistant message', async () => {
    const { controller, onTranscriptMessage } = createHarness(true);
    await controller.start();
    const createSessionRequest = mockCreateSession.mock.calls[0]?.[0];

    createSessionRequest.callbacks.onAssistantTranscriptDelta('Hello ');
    createSessionRequest.callbacks.onAssistantTranscriptDelta('there');
    createSessionRequest.callbacks.onAssistantTranscriptCompleted('Hello there');

    expect(onTranscriptMessage).toHaveBeenCalledWith('assistant', 'Hello there');
    expect(controller.getState()).toBe('listening');
  });
});
