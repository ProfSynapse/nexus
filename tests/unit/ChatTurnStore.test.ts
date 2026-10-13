import { ChatTurnStore, selectReasoning } from '../../src/services/chat/ChatTurnStore';

// Real reducer/store; observers and input events do not supply computed phases.
describe('ChatTurnStore ownership', () => {
  it('separates reasoning, tool rounds, terminal outcome and save status', () => {
    const store = new ChatTurnStore();
    let turn = store.begin('conversation', 'message');
    expect(selectReasoning(turn).phase).toBe('waiting');
    turn = store.dispatch(turn, { type: 'reasoning.delta', text: 'plan' });
    expect(selectReasoning(turn).phase).toBe('thinking');
    turn = store.dispatch(turn, { type: 'response.completed', finishReason: 'tool_calls' });
    expect(selectReasoning(turn).phase).toBe('settled');
    turn = store.dispatch(turn, { type: 'reasoning.delta', text: 'again' });
    expect(selectReasoning(turn).phase).toBe('thinking');
    turn = store.dispatch(turn, { type: 'turn.completed' });
    turn = store.setSaveState(turn, 'failed', 'disk unavailable');
    expect(turn.state.phase).toBe('complete');
    expect(selectReasoning(turn).phase).toBe('settled');
    expect(() => store.begin('conversation', 'message')).toThrow('unsaved');
  });
  it('rejects old-attempt updates when retry reuses the message ID', () => {
    const store = new ChatTurnStore();
    const first = store.begin('conversation', 'message');
    store.dispatch(first, { type: 'turn.completed' });
    store.setSaveState(first, 'saved');
    const second = store.begin('conversation', 'message');
    expect(second.generationId).not.toBe(first.generationId);
    expect(() => store.dispatch(first, { type: 'assistant.delta', text: 'late' })).toThrow('Stale');
    expect(store.get('conversation', 'message')?.state.content).toBe('');
  });
  it('allows remounting from a snapshot and disposes observers independently', () => {
    const store = new ChatTurnStore();
    const observer = jest.fn();
    const stop = store.subscribe(observer);
    const turn = store.begin('a', 'same');
    store.begin('b', 'same');
    stop();
    store.dispatch(turn, { type: 'reasoning.delta', text: 'retained' });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(store.get('a', 'same')?.state.reasoning.text).toBe('retained');
    expect(store.get('b', 'same')?.state.reasoning.text).toBe('');
  });
});
