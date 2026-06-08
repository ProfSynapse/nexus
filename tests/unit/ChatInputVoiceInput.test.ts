import { Component, createMockElement } from 'obsidian';
import { ChatInput } from '../../src/ui/chat/components/ChatInput';

const mockIsAvailable = jest.fn();
const mockStartRecording = jest.fn();
const mockStopRecording = jest.fn();
let capturedCallbacks: {
  onStateChange: (state: 'idle' | 'recording' | 'transcribing') => void;
  onTranscriptReady: (text: string) => void;
  onError: (message: string) => void;
} | null = null;

jest.mock('../../src/ui/chat/controllers/ChatVoiceInputController', () => ({
  ChatVoiceInputController: jest.fn().mockImplementation((_app, callbacks) => {
    capturedCallbacks = callbacks;
    return {
      isAvailable: mockIsAvailable,
      startRecording: mockStartRecording,
      stopRecording: mockStopRecording,
      cleanup: jest.fn()
    };
  })
}));

type ChatInputInternals = ChatInput & {
  sendButton: HTMLButtonElement;
  inputWrapper: HTMLElement;
  inputElement: HTMLElement;
  liveVoiceStopButton: HTMLButtonElement;
};

describe('ChatInput voice input UI', () => {
  beforeEach(() => {
    mockIsAvailable.mockReset();
    mockStartRecording.mockReset();
    mockStopRecording.mockReset();
    capturedCallbacks = null;
  });

  it('shows the microphone action when the composer is empty and voice input is available', () => {
    mockIsAvailable.mockReturnValue(true);

    const input = new ChatInput(
      createMockElement('div'),
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      new Component()
    );

    const { sendButton } = input as ChatInputInternals;
    expect(sendButton.setAttribute).toHaveBeenCalledWith('aria-label', 'Start voice input');
  });

  it('returns to the normal send action when text is present', () => {
    mockIsAvailable.mockReturnValue(true);

    const input = new ChatInput(
      createMockElement('div'),
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      new Component()
    );

    const { sendButton } = input as ChatInputInternals;
    jest.clearAllMocks();

    const internals = input as ChatInputInternals & {
      inputElement: HTMLElement;
      updateUI: () => void;
    };
    internals.inputElement.textContent = 'Hello from voice input';
    internals.updateUI();

    expect(sendButton.setAttribute).toHaveBeenCalledWith('aria-label', 'Send message');
  });

  it('switches into the recording UI when the voice controller reports recording state', () => {
    mockIsAvailable.mockReturnValue(true);

    const input = new ChatInput(
      createMockElement('div'),
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      new Component()
    );

    const { inputWrapper, sendButton } = input as ChatInputInternals;

    capturedCallbacks?.onStateChange('recording');

    expect(inputWrapper.addClass).toHaveBeenCalledWith('chat-input-voice-recording');
    expect(sendButton.setAttribute).toHaveBeenCalledWith('aria-label', 'Stop recording');
  });

  it('switches into the live voice composer UI and disables text entry', () => {
    mockIsAvailable.mockReturnValue(true);

    const input = new ChatInput(
      createMockElement('div'),
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      new Component()
    );

    const { inputElement, inputWrapper, sendButton } = input as ChatInputInternals;

    input.setLiveVoiceState('assistant-speaking');

    expect(input.getLiveVoiceState()).toBe('assistant-speaking');
    expect(inputWrapper.addClass).toHaveBeenCalledWith('chat-input-live-mode');
    expect(inputWrapper.addClass).toHaveBeenCalledWith('chat-input-live-assistant-speaking');
    expect(sendButton.disabled).toBe(true);
    expect(inputElement.contentEditable).toBe('false');
  });

  it('uses the embedded live voice stop button callback', () => {
    mockIsAvailable.mockReturnValue(true);

    const component = new Component();
    const stopLiveVoice = jest.fn();
    const registerDomEventSpy = jest.spyOn(component, 'registerDomEvent');

    const input = new ChatInput(
      createMockElement('div'),
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      component,
      stopLiveVoice
    );

    const { liveVoiceStopButton } = input as ChatInputInternals;
    const registration = registerDomEventSpy.mock.calls.find(([element, eventName]) => (
      element === liveVoiceStopButton && eventName === 'click'
    ));

    expect(registration).toBeDefined();
    const handler = registration?.[2] as EventListener;
    handler(new Event('click'));

    expect(stopLiveVoice).toHaveBeenCalledTimes(1);
  });
});
