import { Component, createMockElement } from 'obsidian';
import { ChatLiveVoiceController } from '../../src/ui/chat/controllers/ChatLiveVoiceController';
import type { ChatInput } from '../../src/ui/chat/components/ChatInput';
import type { ToolStatusBar } from '../../src/ui/chat/components/ToolStatusBar';

describe('ChatLiveVoiceController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  function createHarness(hasConversation = true) {
    const chatInput = {
      setLiveVoiceState: jest.fn(),
    } as unknown as ChatInput;
    const toolStatusBar = {
      pushLiveVoiceStatus: jest.fn(),
      clearLiveVoiceStatus: jest.fn(),
    } as unknown as ToolStatusBar;
    const liveVoiceButton = createMockElement('button');
    const component = new Component();
    const registerDomEventSpy = jest.spyOn(component, 'registerDomEvent');
    const controller = new ChatLiveVoiceController({
      chatInput,
      toolStatusBar,
      liveVoiceButton,
      getHasConversation: () => hasConversation,
      component,
    });

    return {
      chatInput,
      controller,
      liveVoiceButton,
      registerDomEventSpy,
      toolStatusBar,
    };
  }

  it('reports a clear error when no conversation is selected', () => {
    const { chatInput, controller, toolStatusBar } = createHarness(false);

    controller.start();

    expect(chatInput.setLiveVoiceState).not.toHaveBeenCalled();
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenCalledWith(
      'Select or create a conversation to use live voice.',
      'failed'
    );
  });

  it('enters connecting state and then reports unavailable runtime wiring', () => {
    const { chatInput, controller, liveVoiceButton, toolStatusBar } = createHarness(true);

    controller.start();

    expect(controller.getState()).toBe('connecting');
    expect(chatInput.setLiveVoiceState).toHaveBeenCalledWith('connecting');
    expect(liveVoiceButton.addClass).toHaveBeenCalledWith('chat-live-voice-button-active');
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenCalledWith('Connecting live voice...', 'present');

    jest.advanceTimersByTime(700);

    expect(controller.getState()).toBe('error');
    expect(chatInput.setLiveVoiceState).toHaveBeenCalledWith('error');
    expect(toolStatusBar.pushLiveVoiceStatus).toHaveBeenCalledWith(
      'Live voice provider is not connected yet.',
      'failed'
    );
  });

  it('stops the live voice UI and clears the status line', () => {
    const { chatInput, controller, liveVoiceButton, toolStatusBar } = createHarness(true);

    controller.start();
    controller.stop();

    expect(controller.getState()).toBe('inactive');
    expect(chatInput.setLiveVoiceState).toHaveBeenLastCalledWith('inactive');
    expect(liveVoiceButton.removeClass).toHaveBeenCalledWith('chat-live-voice-button-active');
    expect(toolStatusBar.clearLiveVoiceStatus).toHaveBeenCalledTimes(1);
  });

  it('wires the header live voice button to start the controller', () => {
    const { controller, liveVoiceButton, registerDomEventSpy } = createHarness(true);
    const registration = registerDomEventSpy.mock.calls.find(([element, eventName]) => (
      element === liveVoiceButton && eventName === 'click'
    ));

    expect(registration).toBeDefined();
    const handler = registration?.[2] as EventListener;
    handler(new Event('click'));

    expect(controller.getState()).toBe('connecting');
  });
});
