import { Component, createMockElement } from 'obsidian';
import { ChatInput } from '../../src/ui/chat/components/ChatInput';

describe('ChatInput pre-send compaction state', () => {
  it('reduces the input UI to a disabled/busy state while transcript compaction indicator is active', () => {
    const container = createMockElement('div');
    const component = new Component();

    const input = new ChatInput(
      container,
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      component
    );

    input.setPreSendCompacting(true);

    const inputElement = (input as any).inputElement;
    const sendButton = (input as any).sendButton;

    expect(container.addClass).toHaveBeenCalledWith('chat-input-compacting');
    expect(inputElement.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
    expect(inputElement.setAttribute).toHaveBeenCalledWith(
      'data-placeholder',
      'Compacting context before sending...'
    );
    expect(sendButton.disabled).toBe(true);
  });

  it('restores the normal input state when compaction completes', () => {
    const container = createMockElement('div');
    const component = new Component();

    const input = new ChatInput(
      container,
      jest.fn(),
      () => false,
      undefined,
      undefined,
      () => true,
      component
    );

    input.setPreSendCompacting(true);
    input.setPreSendCompacting(false);

    const inputElement = (input as any).inputElement;

    expect(container.removeClass).toHaveBeenCalledWith('chat-input-compacting');
    expect(inputElement.setAttribute).toHaveBeenCalledWith('aria-busy', 'false');
  });
});
