import { Component, createMockElement } from 'obsidian';
import { ChatInput } from '../../src/ui/chat/components/ChatInput';
import { ContentEditableHelper } from '../../src/ui/chat/utils/ContentEditableHelper';
import { ReferenceExtractor } from '../../src/ui/chat/utils/ReferenceExtractor';

type ChatInputWithInternals = ChatInput & {
  inputElement: HTMLElement;
  sendButton: HTMLButtonElement;
  handleSendMessage(): Promise<void>;
  autoResizeInput(): void;
  updateUI(): void;
};

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

    const internals = input as ChatInputWithInternals;
    const inputElement = internals.inputElement;
    const sendButton = internals.sendButton;

    expect(container.addClass).toHaveBeenCalledWith('chat-input-compacting');
    expect(inputElement.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
    expect(inputElement.setAttribute).toHaveBeenCalledWith(
      'data-placeholder',
      'Compacting'
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

    const inputElement = (input as ChatInputWithInternals).inputElement;

    expect(container.removeClass).toHaveBeenCalledWith('chat-input-compacting');
    expect(inputElement.setAttribute).toHaveBeenCalledWith('aria-busy', 'false');
  });
});

describe('ChatInput rejected send', () => {
  afterEach(() => jest.restoreAllMocks());

  it('restores the original reference nodes after a rejected send', async () => {
    const input = new ChatInput(createMockElement('div'), jest.fn().mockResolvedValue(false),
      () => false, undefined, undefined, () => true, new Component());
    const internals = input as ChatInputWithInternals;
    const draftNode = { cloneNode: jest.fn().mockReturnValue({ textContent: 'draft' }) } as unknown as Node;
    const originalInput = {
      childNodes: [draftNode],
      replaceChildren: jest.fn()
    } as unknown as HTMLElement;
    internals.inputElement = originalInput;
    jest.spyOn(ReferenceExtractor, 'extractContent').mockReturnValue({
      plainText: 'draft', references: [], tools: [], prompts: [], notes: [], workspaces: []
    });
    jest.spyOn(ContentEditableHelper, 'clear').mockImplementation(() => undefined);
    const getValue = jest.spyOn(internals, 'getValue').mockReturnValue('');
    jest.spyOn(internals, 'autoResizeInput').mockImplementation(() => undefined);
    jest.spyOn(internals, 'updateUI').mockImplementation(() => undefined);

    await internals.handleSendMessage();

    expect(draftNode.cloneNode).toHaveBeenCalledWith(true);
    expect(originalInput.replaceChildren).toHaveBeenCalledWith({ textContent: 'draft' });

    getValue.mockReturnValue('newer draft');
    await internals.handleSendMessage();
    expect(originalInput.replaceChildren).toHaveBeenCalledTimes(1);
  });
});
