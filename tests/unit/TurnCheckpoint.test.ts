import {
  FOREIGN_CHECKPOINT_STALE_MS,
  TurnCheckpointer,
  isInterruptedCheckpoint,
  repairInterruptedTurn
} from '../../src/services/chat/TurnCheckpoint';
import { StreamingResponseService } from '../../src/services/chat/StreamingResponseService';
import { ChatService } from '../../src/services/chat/ChatService';
import type { ConversationData, ConversationMessage } from '../../src/types/chat/ChatTypes';

describe('TurnCheckpointer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('saves the first change at once and folds later changes into one save per interval', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const checkpoints = new TurnCheckpointer(save, 2000);

    checkpoints.request();
    await jest.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);

    for (let index = 0; index < 50; index += 1) checkpoints.request();
    await jest.advanceTimersByTimeAsync(1999);
    expect(save).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(2); // nothing new to save
  });

  it('never saves after close, and close waits for a save already running', async () => {
    let finishSave: () => void = () => undefined;
    const order: string[] = [];
    const save = jest.fn(() => new Promise<void>(resolve => {
      order.push('checkpoint started');
      finishSave = () => { order.push('checkpoint finished'); resolve(); };
    }));
    const checkpoints = new TurnCheckpointer(save, 2000);

    checkpoints.request();
    await jest.advanceTimersByTimeAsync(0);
    checkpoints.request(); // pending behind the running save

    const closing = checkpoints.close().then(() => order.push('closed'));
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['checkpoint started']);
    finishSave();
    await closing;
    await jest.advanceTimersByTimeAsync(10_000);

    expect(order).toEqual(['checkpoint started', 'checkpoint finished', 'closed']);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps checkpointing after a failed save', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const save = jest.fn().mockRejectedValueOnce(new Error('disk busy')).mockResolvedValue(undefined);
    const checkpoints = new TurnCheckpointer(save, 2000);

    checkpoints.request();
    await jest.advanceTimersByTimeAsync(0);
    checkpoints.request();
    await jest.advanceTimersByTimeAsync(2000);

    expect(save).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('interrupted checkpoint detection and repair', () => {
  const now = 10_000_000_000;
  const checkpointed = (deviceId: string, at: number): ConversationMessage => ({
    id: 'a1', role: 'assistant', content: 'Half an answer', timestamp: 1, state: 'streaming',
    metadata: { turnCheckpoint: { at, deviceId }, usageNote: 'kept' },
    toolCalls: [
      { id: 'done', type: 'function', function: { name: 'useTools', arguments: '{}' }, result: { ok: true }, success: true },
      { id: 'failed', type: 'function', function: { name: 'useTools', arguments: '{}' }, error: 'boom', success: false },
      { id: 'running', type: 'function', function: { name: 'useTools', arguments: '{}' } }
    ]
  } as ConversationMessage);

  it('treats this device\'s own checkpoint as interrupted at once', () => {
    expect(isInterruptedCheckpoint(checkpointed('me', now - 1000), 'me', now)).toBe(true);
  });

  it('leaves another device\'s recent checkpoint alone, and repairs it once it is stale', () => {
    expect(isInterruptedCheckpoint(checkpointed('other', now - 60_000), 'me', now)).toBe(false);
    expect(isInterruptedCheckpoint(checkpointed('other', now - FOREIGN_CHECKPOINT_STALE_MS - 1), 'me', now)).toBe(true);
  });

  it('ignores streaming messages that were never checkpointed (subagents, older versions)', () => {
    const message = { ...checkpointed('me', now), metadata: {} } as ConversationMessage;
    expect(isInterruptedCheckpoint(message, 'me', now)).toBe(false);
    expect(isInterruptedCheckpoint({ ...checkpointed('me', now), state: 'complete' }, 'me', now)).toBe(false);
  });

  it('keeps the text, marks it aborted, and drops only the tool calls that never finished', () => {
    const repair = repairInterruptedTurn(checkpointed('me', now - 1000));
    expect(repair.state).toBe('aborted');
    expect(repair.toolCalls?.map(call => call.id)).toEqual(['done', 'failed']);
    expect(repair.metadata).toEqual({ usageNote: 'kept', interruptedTurn: { lastCheckpointAt: now - 1000 } });
  });
});

describe('StreamingResponseService mid-turn checkpoints', () => {
  function serviceWith(stream: () => AsyncGenerator<unknown>, updateChatMessage: jest.Mock) {
    const conversation: ConversationData = {
      id: 'conv-1', title: 't', created: 1, updated: 1,
      messages: [{ id: 'a1', role: 'assistant', content: '', timestamp: 1, state: 'draft' } as ConversationMessage]
    } as ConversationData;
    return new StreamingResponseService({
      llmService: { getDefaultModel: () => ({ provider: 'test', model: 'm' }), generateResponseStream: stream },
      conversationService: {
        getConversation: jest.fn(async () => structuredClone(conversation)),
        addMessage: jest.fn().mockResolvedValue(undefined),
        updateConversation: jest.fn().mockResolvedValue(undefined),
        updateChatMessage,
        getDeviceId: () => 'device-1'
      },
      toolCallService: { getAvailableTools: jest.fn().mockReturnValue([]), resetDetectedTools: jest.fn(), handleToolCallDetection: jest.fn(), fireToolEvent: jest.fn() },
      costTrackingService: { createUsageCallback: jest.fn(), extractUsage: jest.fn(), trackMessageUsage: jest.fn() }
    } as never);
  }

  it('saves progress while the turn runs, before it ends', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const updateChatMessage = jest.fn().mockResolvedValue(undefined);
    const service = serviceWith(async function* () {
      yield { type: 'assistant.delta', text: 'First part of the answer' };
      await held; // the provider is still working — the app could crash here
      yield { type: 'turn.completed' };
    }, updateChatMessage);

    const run = (async () => { for await (const _ of service.generateResponse('conv-1', 'hi', { messageId: 'a1' })) { /* drain */ } })();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(updateChatMessage).toHaveBeenCalledWith('conv-1', 'a1', expect.objectContaining({
      content: 'First part of the answer',
      state: 'streaming',
      metadata: { turnCheckpoint: { at: expect.any(Number), deviceId: 'device-1' } }
    }));
    release();
    await run;
  });

  it('always writes the final save last, even with a checkpoint still in flight', async () => {
    const order: string[] = [];
    let finishCheckpoint: () => void = () => undefined;
    const updateChatMessage = jest.fn((_c: string, _m: string, updates: { state?: string }) => {
      if (updates.state === 'streaming') {
        order.push('checkpoint started');
        return new Promise<void>(resolve => { finishCheckpoint = () => { order.push('checkpoint finished'); resolve(); }; });
      }
      order.push(`final ${updates.state}`);
      return Promise.resolve();
    });
    const service = serviceWith(async function* () {
      yield { type: 'assistant.delta', text: 'answer' };
      await new Promise(resolve => setTimeout(resolve, 10));
      yield { type: 'turn.completed' };
    }, updateChatMessage);

    const run = (async () => { for await (const _ of service.generateResponse('conv-1', 'hi', { messageId: 'a1' })) { /* drain */ } })();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(order).toEqual(['checkpoint started']); // final save is waiting for it
    finishCheckpoint();
    await run;

    expect(order).toEqual(['checkpoint started', 'checkpoint finished', 'final complete']);
    const finalCall = updateChatMessage.mock.calls[updateChatMessage.mock.calls.length - 1][2] as { replaceMetadata?: boolean; metadata?: Record<string, unknown> };
    expect(finalCall.replaceMetadata).toBe(true);
    expect(finalCall.metadata?.turnCheckpoint).toBeUndefined();
  });
});

describe('ChatService repairs an interrupted turn when the conversation loads', () => {
  it('shows it as aborted and saves that once', async () => {
    const stored: ConversationData = {
      id: 'conv-1', title: 't', created: 1, updated: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'Do it', timestamp: 1, state: 'complete' } as ConversationMessage,
        {
          id: 'a1', role: 'assistant', content: 'Started on it', timestamp: 2, state: 'streaming',
          metadata: { turnCheckpoint: { at: Date.now() - 5000, deviceId: 'device-1' } },
          toolCalls: [{ id: 'running', type: 'function', function: { name: 'useTools', arguments: '{}' } }]
        } as ConversationMessage
      ]
    } as ConversationData;
    const updateChatMessage = jest.fn().mockResolvedValue(undefined);
    const service = new ChatService({
      conversationService: {
        getConversation: jest.fn(async () => structuredClone(stored)),
        updateChatMessage,
        getDeviceId: () => 'device-1'
      } as never,
      llmService: {} as never,
      vaultName: 'test',
      mcpConnector: { executeTool: jest.fn() }
    });

    const loaded = await service.getConversation('conv-1');

    const assistant = loaded?.messages.find(message => message.id === 'a1');
    expect(assistant).toEqual(expect.objectContaining({ content: 'Started on it', state: 'aborted', toolCalls: [] }));
    expect(updateChatMessage).toHaveBeenCalledTimes(1);
    expect(updateChatMessage).toHaveBeenCalledWith('conv-1', 'a1', expect.objectContaining({ state: 'aborted', replaceMetadata: true }));
  });
});
